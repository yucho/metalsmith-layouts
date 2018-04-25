const debug = require('debug')('metalsmith-nestedlayouts');
const match = require('multimatch');
const Metalsmith = require('metalsmith');
const path = require('path');
const isUtf8 = require('is-utf8');
const jstransformer = require('jstransformer');
const toTransformer = require('inputformat-to-jstransformer');

/**
 * Gets jstransformer for an extension, and caches them
 */

const cache = {};

function getTransformer(ext) {
  if (ext in cache) {
    return cache[ext];
  }

  const transformer = toTransformer(ext);
  cache[ext] = transformer ? jstransformer(transformer) : false;

  return cache[ext];
}

/**
 * Sets the relative path to be prefixed to layout name
 */

let layoutsPrefix = '';

function setLayoutsPrefix({ metalsmith, settings }) {
  const srcPath = metalsmith.source();
  const layoutsPath = metalsmith.path(settings.directory);
  const relativePath = path.relative(srcPath, layoutsPath);

  if (!relativePath.startsWith(`..${path.sep}`)) layoutsPrefix = relativePath;
  else layoutsPrefix = '';
}

/**
 * Creates collection of layouts
 */

function getCollection({ files, metalsmith, settings }) {
  // Read layouts from metalsmith
  if (layoutsPrefix) {
    const matchedFilenames = match(Object.keys(files), path.join(layoutsPrefix, '**/*'));

    const matchedFiles = {};
    for (let i = 0; i < matchedFilenames.length; i += 1) {
      const name = matchedFilenames[i];

      // Strip away path and use base name
      matchedFiles[path.parse(name).base] = files[name];
    }

    return Promise.resolve(matchedFiles);
  }

  // Metalsmith hasn't read the layouts, so create new instance for them
  return new Promise(resolve => {
    new Metalsmith(metalsmith.path()).source(settings.directory).process((err, layouts) => {
      if (err) throw err;

      resolve(layouts);
    });
  });
}

/**
 * Resolves layouts, in the following order:
 * 1. Layouts in the frontmatter
 * 2. Skips file if layout: false in frontmatter
 * 3. Default layout in the settings
 */

function getLayout({ file, settings }) {
  if (file.layout || file.layout === false) {
    return file.layout;
  }

  return settings.default;
}

/**
 * Engine, renders file with the appropriate layout
 */

function render({ filename, files, collection, metadata, settings }) {
  const file = files[filename];

  // Get all outer layouts
  const layouts = [];
  let layoutname = getLayout({ file, settings });
  do {
    layouts.push(layoutname);
    layoutname = collection[layoutname].layout;
  } while (layoutname);

  // Override locals in order of importance
  const locals = Object.assign({}, metadata);
  for (let i = layouts.length - 1; i >= 0; i -= 1) {
    Object.assign(locals, collection[layouts[i]]);
  }
  Object.assign(locals, file);

  // Promise chain for nested layouts
  let chain = Promise.resolve();
  layouts.map(layout => {
    // eslint-disable-next-line arrow-body-style
    chain = chain.then(() => {
      return new Promise(resolve => {
        const extension = layout.split('.').pop();
        const transform = getTransformer(extension);
        const layoutfile = collection[layout];

        debug(`rendering ${filename} with layout ${layout}`);

        // Throw if the layout does not exist
        if (!layoutfile) throw new Error(`cannot find layout ${layout}`);

        // Stringify file contents
        let contents = file.contents.toString();
        Object.assign(locals, { contents });

        // Transform the contents
        contents = transform.render(layoutfile.contents.toString(), settings.engineOptions, locals)
          .body;

        // Update file with results
        file.contents = Buffer.from(contents);

        return resolve();
      });
    });
    return chain;
  });

  return chain.then(() => debug(`done rendering ${filename}`));
}

/**
 * Validate, checks whether a file should be processed
 */

function validate({ filename, files, settings }) {
  const file = files[filename];
  const layout = getLayout({ file, settings });

  debug(`validating ${filename}`);

  // Files without a layout cannot be processed
  if (!layout) {
    debug(`validation failed, ${filename} does not have a layout set`);
    return false;
  }

  // Layouts without an extension cannot be processed
  if (!layout.includes('.')) {
    debug(`validation failed, layout for ${filename} does not have an extension`);
    return false;
  }

  // Files that are not utf8 are ignored
  if (!isUtf8(file.contents)) {
    debug(`validation failed, ${filename} is not utf-8`);
    return false;
  }

  // Files without an applicable jstransformer are ignored
  const extension = layout.split('.').pop();
  const transformer = getTransformer(extension);

  debug(`extension is ${extension}`);

  if (!transformer) {
    debug(`validation failed, no jstransformer found for layout for ${filename}`);
  }

  return transformer;
}

/**
 * Plugin, the main plugin used by metalsmith
 */

module.exports = options => (files, metalsmith, done) => {
  const metadata = metalsmith.metadata();
  const defaults = {
    pattern: '**',
    directory: 'layouts',
    engineOptions: {}
  };
  const settings = Object.assign({}, defaults, options);

  // Check whether the pattern option is valid
  let pattern;

  if (typeof settings.pattern === 'string') pattern = [settings.pattern];
  else if (Array.isArray(settings.pattern)) pattern = settings.pattern.slice();
  else {
    done(
      new Error(
        'invalid pattern, the pattern option should be a string or array of strings. See https://www.npmjs.com/package/metalsmith-layouts#pattern'
      )
    );
  }

  // Filter out layouts
  setLayoutsPrefix({ metalsmith, settings });
  if (layoutsPrefix) pattern.push(`!${path.join(layoutsPrefix, '**')}`);

  // Filter files by the pattern
  const matchedFiles = match(Object.keys(files), pattern);

  // Filter files by validity
  const validFiles = matchedFiles.filter(filename => validate({ filename, files, settings }));

  // Let the user know when there are no files to process
  if (validFiles.length === 0) {
    done(
      new Error(
        'no files to process. See https://www.npmjs.com/package/metalsmith-layouts#no-files-to-process'
      )
    );
  } else {
    // Create collection of layouts
    getCollection({ files, metalsmith, settings })
      // Map all files that should be processed to an array of promises and call done when finished
      // eslint-disable-next-line arrow-body-style
      .then(collection => {
        return Promise.all(
          validFiles.map(filename => render({ filename, files, collection, metadata, settings }))
        );
      })
      .then(() => done())
      .catch(/* istanbul ignore next */ error => done(error));
  }
};
