/**
 * Created by mihai on 4/21/2016.
 */

var ModuleFilenameHelpers = require('webpack/lib/ModuleFilenameHelpers');
var RawSource = require('webpack-core/lib/RawSource');
var SourceMapSource = require("webpack-core/lib/SourceMapSource");
var SourceMapConsumer = require('webpack-core/lib/source-map').SourceMapConsumer;
var SourceMapGenerator = require('webpack-core/lib/source-map').SourceMapGenerator;
var uglify = require('uglify-js');

function LmpePlugin(options){
	this.options = options = options || {};
	options.sourceMap = options.sourceMap !== false;
	options.lazyEval = options.lazyEval !== false;
}
module.exports = LmpePlugin;

LmpePlugin.prototype.apply = function(compiler){
	var self = this,
		options = self.options;

	compiler.plugin('compilation', function(compilation){
		if(options.sourceMap){
			compilation.plugin('build-module', function(module){
				module.useSourceMap = true;
			});
		}
		var templateOptions=uglify.defaults(options, {
			moduleFilenameTemplate: compiler.options.output.moduleFilenameTemplate,
			sourceMapComment: '//# sourceMappingURL=[url]',
			sourceMap: options.sourceMap,
			columns: true
		});
		compilation.moduleTemplate.apply(
			new LmpeTemplatePlugin(compilation, templateOptions)
		);
	});
};

function LmpeTemplatePlugin(compilation, options){
	this.compilation = compilation;
	this.sourceMapComment = options.sourceMapComment || '//# sourceMappingURL=[url]';
	this.moduleFilenameTemplate = options.moduleFilenameTemplate || 'lmpe:///[resource-path]?[hash]';
	this.options = options;
}

LmpeTemplatePlugin.prototype.apply = function(moduleTemplate){
	var self = this,
		options = this.options;
	moduleTemplate.plugin('module', function(source, module){
		if(source.__LmpeData)
			return source.__LmpeData;

		if(source.sourceAndMap){
			var sourceAndMap = source.sourceAndMap(options);
			var inputSourceMap = sourceAndMap.map;
			var content = sourceAndMap.source;
		}else{
			var inputSourceMap = source.map(options);
			var content = source.source();
		}

		var file = module.id + '.js';
		var oldWarnFunction = uglify.AST_Node.warn_function;
		var warnings = [];
		try{
			if(options.sourceMap){
				// Clone (flat) the sourcemap to ensure that the mutations below do not persist.
				inputSourceMap = Object.keys(inputSourceMap).reduce(function(obj, key){
					obj[key] = inputSourceMap[key];
					return obj;
				}, {});

				if(options.lazyEval){
					var modules = inputSourceMap.sources.map(function(source){
						var module = self.compilation.findModule(source);
						return module || source;
					});
					var moduleFilenames = modules.map(function(module){
						return ModuleFilenameHelpers.createFilename(module, self.moduleFilenameTemplate, this.requestShortener);
					}, this);
					moduleFilenames = ModuleFilenameHelpers.replaceDuplicates(moduleFilenames, function(filename, i, n){
						for(var j = 0; j < n; j++)
							filename += '*';
						return filename;
					});
					inputSourceMap.sources = moduleFilenames;
					if(inputSourceMap.sourcesContent){
						inputSourceMap.sourcesContent = inputSourceMap.sourcesContent.map(function(content, i){
							return content + '\n\n\n' + ModuleFilenameHelpers.createFooter(modules[i], this.requestShortener);
						}, this);
					}
				}
				inputSourceMap.sourceRoot = '';
				inputSourceMap.file = file;

				//uglify
				inputSourceMapConsumer = new SourceMapConsumer(inputSourceMap);
				uglify.AST_Node.warn_function = function(warning){
					var match = /\[.+:([0-9]+),([0-9]+)\]/.exec(warning);
					var line = +match[1];
					var column = +match[2];
					var original = inputSourceMapConsumer.originalPositionFor({
						line: line,
						column: column
					});
					if(!original || !original.source || original.source === file) return;
					warnings.push(warning.replace(/\[.+:([0-9]+),([0-9]+)\]/, '') + '[' + requestShortener.shorten(original.source) + ':' + original.line + ',' + original.column + ']');
				};
			}else{
				uglify.AST_Node.warn_function = function(warning){
					warnings.push(warning);
				};
			}

			uglify.base54.reset();
			var ast = uglify.parse(content, {
				filename: file
			});
			if(options.compress !== false){
				ast.figure_out_scope();
				var compress = uglify.Compressor(options.compress || {});
				ast = ast.transform(compress);
			}
			if(options.mangle !== false){
				ast.figure_out_scope();
				ast.compute_char_frequency(options.mangle || {});
				ast.mangle_names(options.mangle || {});
				if(options.mangle && options.mangle.props){
					uglify.mangle_properties(ast, options.mangle.props);
				}
			}
			var output = {};
			output.comments = Object.prototype.hasOwnProperty.call(options, 'comments') ? options.comments : /^\**!|@preserve|@license/;
			output.beautify = options.beautify;
			for(var k in options.output){
				output[k] = options.output[k];
			}
			if(options.sourceMap !== false){
				var outSourceMap = uglify.SourceMap({
					file: file,
					root: ''
				});
				output.source_map = outSourceMap;
			}
			var stream = uglify.OutputStream(output);
			ast.print(stream);
			stream = stream + '';
			if(options.lazyEval && outSourceMap){
				outSourceMap = outSourceMap + '';

				var sourceMap = SourceMapGenerator.fromSourceMap(new SourceMapConsumer(JSON.parse(outSourceMap)));
				sourceMap.setSourceContent(file, content);
				sourceMap.applySourceMap(inputSourceMapConsumer, file);
				sourceMap = sourceMap.toJSON();

				var footer = '\n' + self.sourceMapComment.replace(/\[url\]/g, 'data:application/json;base64,' + new Buffer(JSON.stringify(sourceMap)).toString('base64'));
				stream = stream + footer;
				stream = 'eval(' + JSON.stringify(stream) + ');'
			}

			source.__LmpeData = (!options.lazyEval && outSourceMap ?
				new SourceMapSource(stream, file, JSON.parse(outSourceMap), content, inputSourceMap) :
				new RawSource(stream));

			//source.__LmpeData = new RawSource(stream);
			if(warnings.length > 0){
				self.compilation.warnings.push(new Error(file + ' from Lmpe\n' + warnings.join('\n')));
			}
			return source.__LmpeData;
		}catch(err){
			if(err.line){
				var original = inputSourceMapConsumer && inputSourceMapConsumer.originalPositionFor({
						line: err.line,
						column: err.col
					});
				if(original && original.source){
					self.compilation.errors.push(new Error(file + ' from Lmpe\n' + err.message + ' [' + requestShortener.shorten(original.source) + ':' + original.line + ',' + original.column + ']'));
				}else{
					self.compilation.errors.push(new Error(file + ' from Lmpe\n' + err.message + ' [' + file + ':' + err.line + ',' + err.col + ']'));
				}
			}else if(err.msg){
				self.compilation.errors.push(new Error(file + ' from Lmpe\n' + err.msg));
			}else
				self.compilation.errors.push(new Error(file + ' from Lmpe\n' + err.stack));
		}finally{
			uglify.AST_Node.warn_function = oldWarnFunction;
		}
	});
	moduleTemplate.plugin('hash', function(hash){
		hash.update('lmpe');
		hash.update('1');
	});
}
