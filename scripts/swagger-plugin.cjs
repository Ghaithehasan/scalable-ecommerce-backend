// The Swagger transformer receives escaped Unicode paths from TypeScript 6
// on Windows. Normalize its synthetic local imports to portable relative
// paths, while retaining the official DTO/response metadata transformer.
const ts = require('typescript');
const path = require('node:path');
const swagger = require('@nestjs/swagger/plugin');

exports.before = (options, program) => (context) => {
  const transform = swagger.before(
    { ...options, esmCompatible: false },
    program,
  )(context);
  const sourceRoot = path.resolve(program.getCurrentDirectory(), 'src');
  return (sourceFile) => {
    const localImport = (specifier) => {
      const normalized = specifier.replace(/\\/g, '/');
      const marker = normalized.lastIndexOf('/src/');
      if (marker < 0) return specifier;
      const suffix = normalized.slice(marker + 5).replace(/\.[cm]?js$/, '.ts');
      const target = path.resolve(
        sourceRoot,
        suffix.endsWith('.ts') ? suffix : suffix + '.ts',
      );
      if (
        !target.startsWith(sourceRoot + path.sep) ||
        !ts.sys.fileExists(target)
      )
        return specifier;
      const relative = path
        .relative(path.dirname(sourceFile.fileName), target)
        .replace(/\\/g, '/')
        .replace(/\.ts$/, '.js');
      return relative.startsWith('.') ? relative : './' + relative;
    };
    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text.includes('require(')) {
        const text = node.text.replace(
          /require\("([^"]+)"\)/g,
          (_match, specifier) =>
            `require(${JSON.stringify(localImport(specifier))})`,
        );
        if (text !== node.text) return context.factory.createIdentifier(text);
      }
      if (ts.isStringLiteral(node)) {
        const text = localImport(node.text);
        if (text !== node.text)
          return context.factory.createStringLiteral(text);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(transform(sourceFile), visit);
  };
};
