const debug = require('debug')('metalsmith-nestedlayouts');
const match = require('multimatch');
const metal = require('metalsmith');
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
    metal(metalsmith.path())
      .source(settings.directory)
      .process((err, layouts) => {
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
  return new Promise(resolve => {
    const file = files[filename];
    const layoutname = getLayout({ file, settings });
    const extension = layoutname.split('.').pop();

    debug(`rendering ${filename} with layout ${layoutname}`);

    // Stringify file contents
    let contents = file.contents.toString();

    const transform = getTransformer(extension);
    const locals = Object.assign({}, metadata, file, { contents });
    const layout = collection[layoutname];

    if (!layout) throw new Error(`cannot find layout ${layoutname}`);

    // Transform the contents
    contents = transform.render(layout.contents.toString(), settings.engineOptions, locals).body;

    // Update file with results
    // eslint-disable-next-line no-param-reassign
    file.contents = Buffer.from(contents);

    debug(`done rendering ${filename}`);
    return resolve();
  });
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

  if (!transformer) {
    debug(`validation failed, no jstransformer found for layout for ${filename}`);
  }

  return transformer;
}

/**
 * Renders nested layouts in order of inheritance
 */

function renderNestedLayouts({ collection, metadata, settings, metalsmith }) {
  // Use symbols to do things under the hood
  const seen = Symbol('prevent circular dependency');
  const children = Symbol('children layouts');
  const finished = Symbol('finished building tree');

  // Layouts without parents
  const roots = [];

  // Create an array of children for each parent
  function createLayoutTree(name) {
    const file = collection[name];
    if (!file || file[finished]) return false;

    // Throw if circular inheritance is found
    if (file[seen]) throw new Error(`circular dependency found in ${name}`);
    file[seen] = true;

    if (!file[finished]) {
      if (file.layout) {
        const parentname = file.layout;
        const parent = collection[parentname];
        createLayoutTree(parentname);

        if (parent[children]) parent[children].push(name);
        else parent[children] = [name];
      } else roots.push(name);
    }

    file[finished] = true;
    return delete file[seen];
  }

  Object.keys(collection).forEach(filename => {
    createLayoutTree(filename);
  });

  // Render layouts in order of inheritance level
  let tasks = Promise.resolve();
  function renderLayouts(parentlevel) {
    parentlevel.forEach(parent => {
      const childlevel = collection[parent][children];
      if (childlevel) {
        tasks = tasks.then(() =>
          Promise.all(
            childlevel.map(child =>
              render({
                filename: child,
                files: collection,
                collection,
                metadata,
                settings,
                metalsmith
              })
            )
          )
        );
        renderLayouts(childlevel);
      }
    });
  }
  renderLayouts(roots);

  // Clean up
  tasks = tasks.then(() => {
    Object.keys(collection).forEach(filename => {
      const file = collection[filename];
      delete file[children];
      delete file[finished];

      // Remove layout property to avoid double-render
      delete file.layout;
    });
    return Promise.resolve(collection);
  });

  return tasks;
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
  pattern.push(`!${path.join(layoutsPrefix, '**')}`);

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
  }

  // Create collection of layouts
  getCollection({ files, metalsmith, settings })
    // Render collection before other files
    .then(collection => renderNestedLayouts({ collection, metadata, settings, metalsmith }))
    // Map all files that should be processed to an array of promises and call done when finished
    .then(collection => {
      Promise.all(
        validFiles.map(filename => render({ filename, files, collection, metadata, settings }))
      );
    })
    .then(() => done())
    .catch(/* istanbul ignore next */ error => done(error));
};
