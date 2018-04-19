# metalsmith-nestedlayouts

[![build status][build-badge]][build-url]
[![coverage status][coverage-badge]][coverage-url]

> A metalsmith plugin for nested layouts

This plugin modifies the behavior of [metalsmith-layout](https://github.com/ismay/metalsmith-layouts).

#### It reads from collection rather than files

There are 2 distinct advantages to this behavior:
1. You can add frontmatter to layouts
2. Which means you can nest layouts inside another by adding a layout property in a layout

#### It analyzes layouts dependency, renders layouts first, then renders contents files

So after the first render, all layouts are ready to be applied to contents files.

#### It checks whether or not layouts directory is inside the Metalsmith source

So it won’t reread the layouts that had already been read by the Metalsmith instance.

## Usage

Refer to [metalsmith-layout doc](https://github.com/ismay/metalsmith-layouts#metalsmith-layouts) for the usage. This plugin does not break the original API and can simply replace it. The only meaningful additions are that you may now add a `layout` property inside a layout, and that you may set `directory` to a subdirectory of `source`. If you do, you probably want to delete the layouts from the Metalsmith output because they serve no practical purpose. Example:

```javascript
Metalsmith
  .source('./src')
  .use(layouts({ directory: 'src/layouts' }))
  .use(ignore('src/layouts/*'))
```

## Credits

* [Ismay Wolff](https://github.com/ismay) for creating the awesome [metalsmith-layouts](https://github.com/ismay/metalsmith-layouts), on which this plugin is based

## License

[MIT](https://yucho.mit-license.org/)

[build-badge]: https://travis-ci.org/yucho/metalsmith-nestedlayouts.svg
[build-url]: https://travis-ci.org/yucho/metalsmith-nestedlayouts
[coverage-badge]: https://coveralls.io/repos/github/yucho/metalsmith-nestedlayouts/badge.svg
[coverage-url]: https://coveralls.io/github/yucho/metalsmith-nestedlayouts
