# Finite for Figma

A Figma plugin that moves designs between Figma and Finite as files. It has two buttons. **Save selection for Finite** writes the selected frames to a `<name>.figma.json` file, and **Open a Finite export** builds Figma layers from a `.figma.json` file that Finite exported. The plugin never touches the network: its manifest sets `networkAccess` to `none`, so everything moves through files you save and pick.

The plugin only copies values between the Plugin API and the payload, a JSON format defined in `crates/transfer/src/figma/payload.rs` and mirrored in `src/payload.ts`. All conversion between that payload and Finite's artboards happens in the server. See `docs/import-export.md` for how that works.

## Get it

Every Finite release attaches the plugin, built, as [`finite-figma-plugin.zip`](https://github.com/noxaur/finite/releases/latest/download/finite-figma-plugin.zip). The web app's Export menu links to the same file. Unzip it, then load the `manifest.json` inside as described under [Load it in Figma](#load-it-in-figma). To use a change before it's released, build it from source.

## Build

From the repository root:

```sh
vp install
vp run -F figma-plugin build
```

This writes `dist/code.js` and `dist/ui.html`, which `manifest.json` points at. Figma loads the plugin's code in a sandbox and its UI as one HTML string, so `vp pack` bundles each into a single script with no imports, and `scripts/inline-ui.mjs` puts the UI script inside `ui.html`. Run `vp test` in this folder to run the tests. CI runs the tests and the build, and the release workflow (`.github/workflows/release.yml`) zips `manifest.json`, `dist/code.js` and `dist/ui.html` into the release.

## Load it in Figma

You need the Figma desktop app. Open any design file, then choose **Plugins → Development → Import plugin from manifest…** and pick `manifest.json`: the one in the unzipped release, or `apps/figma-plugin/manifest.json` for a build from source. After that, **Plugins → Development → Finite** runs it. With a build from source, rebuild after a code change and run the plugin again. With a release, unzip the newer one over the old folder.

## Use it with Finite

**From Figma to Finite.** Select one or more frames and run the plugin. Click **Save selection for Finite** and your browser downloads `<name>.figma.json`. In Finite, click **Import** and pick that file. Each selected frame becomes an artboard. The plugin saves images and vectors too, as base64 and SVG, so the file can be large.

**From Finite to Figma.** In Finite, open **Export** and choose **<artboard> for Figma**. In Figma, run the plugin and click **Open a Finite export**, then pick the downloaded file. The plugin builds the layers to the right of what's already on the page, selects them and zooms to them.

The result line under the buttons says what happened. When a font in the file isn't installed in Figma, the plugin uses the closest weight of the same family, or Inter, and lists each swap as `Foo Bold → Inter Bold`.

## What doesn't carry over

- Gradients run left to right, because the payload has no gradient direction.
- An image fill with `CROP` as its scale mode becomes `FILL`, because the payload has no crop transform.
- A selected layer that isn't a frame (a loose rectangle or text) is skipped on save, and the result line counts the skipped layers.
- Components and instances build as plain frames.
