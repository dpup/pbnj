
/**
 * @fileoverview Class for managing a "project", in otherwords the parsing and
 * compilation of a set of protocol buffer schemas.
 */

var kew = require('kew')
var fs = require('fs')
var path = require('path')
var soynode = require('soynode')
var util = require('util')

var helper = require('./helper')
var parser = require('./parser')


/**
 * @param {string=} opt_basePath The base path, for a default configuration
 *     of protoc_path and out_path.
 * @constructor
 */
function Project(opt_basePath) {
  var basePath = opt_basePath || process.cwd()

  /** @private {string} */
  this._basePath = basePath

  /** @private {?} */
  this._additionalCompilerOptions = null

  /**
   * Look for protos starting at the specified path. Defaults to cwd and default includes.
   * @private {Array.<string>}
   */
  this._protocPaths = [basePath, path.resolve(__dirname, '../include')]

  /**
   * Default out dir
   * @private {string}
   */
  this._outDir = path.join(basePath, 'genfiles')

  /**
   * Where files are output to for each suffix.
   * @private {!Object<string, string>}
   */
  this._outDirs = {}

  /**
   * The template directory, relative to the base path.
   * @private {string}
   */
  this._templateDir = basePath

  /**
   * Suffix for generated files.
   * @private {string}
   */
  this._defaultSuffix = '.js'

  /**
   * Map of absolute filenames to the parsed proto descriptor.
   * @private {Object.<pbnj.ProtoDescriptor>}
   */
  this._protos = {}

  /**
   * Array of compile jobs.
   * @private {Array.<{proto: string, template: string, suffix: string}>}
   */
  this._compileJobs = []

  /** @private {boolean} */
  this._resolvedExtensions = false

  /** @private {Object.<string, (MessageDescriptor|EnumDescriptor)>} */
  this._typesByName = {}
}
module.exports = Project


/**
 * @param {ProtoDescriptor} descriptor
 * @param {string} outFile
 * @param {string} compiledContents
 * @return {Promise}
 */
Project.prototype._outputFn = Project.defaultOutputFn = function (descriptor, outFile, compiledContents) {
  return helper.mkdir(outFile).then(function () {
    return kew.nfcall(fs.writeFile, outFile, compiledContents)
  })
}


/**
 * Gets a string representation of this object, compatible with `util.inspect`
 * @return {string}
 */
Project.prototype.inspect = function () {
  return util.inspect({
    basePath: this._basePath,
    protocPaths: this._protocPaths,
    outDir: this._outDir,
    templateDir: this._templateDir,
    jobs: this._compileJobs,
    protos: this._protos
  }, false, null)
}


/**
 * Loads Closure Templates in the provided folder, relative to the project's basePath.
 * @param {string} templateFolder
 * @return {Project}
 */
Project.prototype.setTemplateDir = function (templateFolder) {
  this._templateDir = path.resolve(this._basePath, templateFolder)
  return this
}


/**
 * Overrides the output function, default writes the compiled contents to a file. Arguments will
 * be the proto descriptor, the filename that would normally be written, and the compiled contents.
 * @param {{function (ProtoDescriptor, string, string) : Promise}} outputFn
 * @return {Project}
 */
Project.prototype.setOutputFn = function (outputFn) {
  this._outputFn = outputFn
  return this
}

/**
 * Set additional compiler options (these are merged onto the default SoyCompiler options).
 * @param {?} additionalCompilerOptions these merge onto the default {@link SoyOptions}
 * @return {Project}
 */
Project.prototype.setAdditionalCompilerOptions = function (options) {
  this._additionalCompilerOptions = options
  return this
}


/**
 * Sets the output directory to use for each suffix. If no suffix is passed in, sets the default outDir.
 * It will be resolved relative to the first directory
 * @param {string} outDir
 * @param {string=} opt_suffix
 * @return {Project}
 */
Project.prototype.setOutDir = function (outDir, opt_suffix) {
  if (!opt_suffix) {
    this._outDir = path.resolve(this._basePath, outDir)
  } else {
    this._outDirs[opt_suffix] = path.resolve(this._basePath, outDir)
  }
  return this
}


/**
 * Sets the protoc_path for resolving proto files.
 * @param {Array.<string>} protocPaths
 * @return {Project}
 */
Project.prototype.setProtocPaths = function (protocPaths) {
  if (!Array.isArray(protocPaths)) throw new Error('required array')
  this._protocPaths = protocPaths
  return this
}


/**
 * Adds a compilation job.
 * @param {string} protoFile The proto file to compile, all imports will be followed.
 * @param {string} templateName The Soy template name to use when compiling.
 * @param {string=} opt_suffix Optional suffix for generated files.
 * @return {Project}
 */
Project.prototype.addJob = function (protoFile, templateName, opt_suffix) {
  this.addProto(protoFile)
  this._compileJobs.push({
    proto: this._resolve(protoFile),
    template: templateName,
    suffix: opt_suffix
  })
  return this
}


/**
 * Processes a protocol buffer schema file, synchronously.
 * @param {string} fileName Filename relative to the project's base path.
 * @return {Project}
 */
Project.prototype.addProto = function (fileName) {
  this._processProto(fileName)
  return this
}

/**
 * Processes a protocol buffer schema file, synchronously.
 * @param {string} fileName Filename relative to protoc_paths
 * @return {ProtoDescriptor}
 */
Project.prototype._processProto = function (fileName) {
  // TODO(dan): Make async.

  var filePath = this._resolve(fileName)

  var proto = this._protos[filePath]
  if (!proto) {
    var fileContents = fs.readFileSync(filePath, 'utf8')
    proto = this._protos[filePath] = parser(filePath, fileContents)
    proto.getImportNames().forEach(function (importName) {
      proto.addImport(this._processProto(importName))
    }, this)

    this._discoverTypes(proto, proto.getPackage())
    this._resolveTypes(proto, proto.getPackage())
  }
  return proto
}


/**
 * Index all protobuf types
 * @param {MessageDescriptor|ProtoDescriptor} proto
 * @param {string} package
 * @private
 */
Project.prototype._discoverTypes = function (proto, package) {
  proto.getMessages().forEach(function (message) {
    message.setPackage(package)

    var messageName = helper.joinPackage(package, message.getName())
    this._typesByName[messageName] = message

    this._discoverTypes(message, messageName)
  }, this)

  proto.getEnums().forEach(function (e) {
    e.setPackage(package)

    var eName = helper.joinPackage(package, e.getName())
    this._typesByName[eName] = e
  }, this)

  if (!proto.getServices) {
    return // no services nested within messages
  }
  proto.getServices().forEach(function (e) {
    e.setPackage(package)
  })
}


/**
 * Resolve all protobuf types into the FieldDescriptors that name them.
 * @param {MessageDescriptor|ProtoDescriptor} proto
 * @param {string} package
 * @private
 */
Project.prototype._resolveTypes = function (proto, package) {
  proto.getMessages().forEach(function (message) {
    message.getFields().forEach(function (field) {
      if (field.isNativeType()) return

      var typeName = field.getRawType()
      var innerType = message.getMessage(typeName) || message.getEnum(typeName)
      if (innerType) {
        field.setTypeDescriptor(innerType)
        return
      }

      var type = this._resolveGlobalTypeOrFail(package, typeName,
        'Could not resolve type of field ' + field.getName() +
        ' on message ' + message.getName() +
        ' : ' + field.getRawType())
      field.setTypeDescriptor(type)
    }, this)

    this._resolveTypes(message, helper.joinPackage(package, message.getName()))
  }, this)

  // resolve type references on service descriptors
  if (!proto.getServices) {
    return // there are no services nested within message blocks
  }
  proto.getServices().forEach(function (service) {
    service.getMethods().forEach(function (method) {
      var inputType = null
      var outputType = null
      // we only resolve non-native types
      if (!method.isNativeInputType()) {
        inputType = this._resolveGlobalTypeOrFail(package, method.getRawInputType(),
          'Could not resolve input type of method ' + method.getName() +
          ' on service ' + service.getName() +
          ' : ' + method.getRawInputType())
      }
      if (!method.isNativeOutputType()) {
        outputType = this._resolveGlobalTypeOrFail(package, method.getRawOutputType(),
          'Could not resolve output type of method ' + method.getName() +
          ' on service ' + service.getName() +
          ' : ' + method.getRawOutputType())
      }
      method.setTypeDescriptors(inputType, outputType)
    }, this)
  }, this)
}

Project.prototype._resolveGlobalTypeOrFail = function (package, typeName, failureDescription) {
  var packageStack = package.split('.')
  for (var i = 0; i <= packageStack.length; i++) {
    var scope = packageStack.slice(0, i).join('.')
    var globalTypeName = helper.joinPackage(scope, typeName)
    var type = this._typesByName[globalTypeName]
    if (type) {
      return type
    }
  }
  throw new Error(failureDescription)
}

/**
 * Resolve all protobuf extensions into the main messages.
 * @private
 */
Project.prototype._resolveExtensions = function () {
  if (this._resolvedExtensions) return

  var protos = this.getProtos()
  var messagesByName = {}
  var i, j, descriptor

  for (i = 0; i < protos.length; i++) {
    descriptor = protos[i]
    var messages = descriptor.getMessages()
    for (j = 0; j < messages.length; j++) {
      var m = messages[j]
      var mName = descriptor.getPackage() + '.' + m.getName()

      messagesByName[mName] = m
    }
  }

  for (i = 0; i < protos.length; i++) {
    descriptor = protos[i]
    var extensions = descriptor.getExtends()
    for (j = 0; j < extensions.length; j++) {
      var e = extensions[j]
      var eName = descriptor.getPackage() + '.' + e.getName()
      if (messagesByName[eName]) {
        e.mergeInto(messagesByName[eName])
      }
    }
  }

  this._resolvedExtensions = true
}



/**
 * Executes all the compilation jobs.
 * @return {Promise} A promise of when all compilation jobs have finished
 */
Project.prototype.compile = function () {
  this._resolveExtensions()

  var compiler = new soynode.SoyCompiler()
  compiler.setOptions({
    outputDir: this._outDir,
    uniqueDir: false,
    allowDynamicRecompile: false,
    eraseTemporaryFiles: false
  })
  if (this._additionalCompilerOptions) {
    compiler.setOptions(this._additionalCompilerOptions)
  }

  return kew.nfcall(compiler.compileTemplates.bind(compiler, this._templateDir)).then(function () {
    var promises = []

    for (var i = 0; i < this._compileJobs.length; i++) {
      var job = this._compileJobs[i]
      var descriptor = this.getProtos(job.proto)[0]
      var filePath = descriptor.getFilePath()
      if (job.suffix == '.java' && descriptor.getOption('java_outer_classname')) {
        filePath = path.join(path.dirname(filePath), descriptor.getOption('java_outer_classname'))
      } else if ((job.suffix == '.h' || job.suffix == '.m') && descriptor.getOption('ios_classname')) {
        filePath = path.join(path.dirname(filePath), descriptor.getOption('ios_classname'))
      }
      var outDir = (job.suffix && this._outDirs[job.suffix]) ? this._outDirs[job.suffix] : this._outDir
      var relativeFilePath = path.relative(this._basePath, filePath)
      var fileName = path.join(outDir, relativeFilePath + (job.suffix || this._defaultSuffix))
      var contents =  compiler.render(job.template, descriptor.toTemplateObject())
      promises.push(this._outputFn(descriptor, fileName, contents))
    }

    return kew.all(promises)
  }.bind(this))
}


/**
 * Finds the descriptor definition for a particular type name.
 * @param {string} name The type name, e.g. proto.project.FooBar
 * @return {Descriptor}
 */
Project.prototype.findType = function (name) {
  // TODO(dan): Fully implement this to walk through the tree.
  for (var file in this._protos) {
    var descriptor = this._protos[file].findType(name)
    if (descriptor) return descriptor
  }
  return null
}


/**
 * Gets a list of parsed proto descriptors.
 * @param {string} opt_protoFile If specified, only the provided proto will be
 *    returned.
 * @return {Array.<ProtoDescriptor>}
 */
Project.prototype.getProtos = function (opt_protoFile) {
  if (!opt_protoFile) return helper.values(this._protos)

  var protoPath = this._resolve(opt_protoFile)

  if (this._protos[protoPath]) {
    return [this._protos[protoPath]]
  } else {
    throw new Error('Unknown proto file [' + protoPath + ']')
  }
}


/**
 * Returns the full path relative to the base directory.
 * @param {string} fileName
 * @return {string}
 * @throws An error if it could not be resolved
 */
Project.prototype._resolve = function (fileName) {
  for (var i = 0; i < this._protocPaths.length; i++) {
    var protocPath = this._protocPaths[i]
    var filePath = path.resolve(protocPath, fileName)
    try {
      fs.statSync(filePath) // https://github.com/nodejs/io.js/issues/103
      return filePath
    } catch (err) {
      // Expected
    }
  }

  // TODO(nick): it would be nice to report the line number
  // where the import appeared, if this is an import.
  throw new Error('File "' + fileName + '" could not be resolved on protoc paths: ' +
                  this._protocPaths.join(','))
}
