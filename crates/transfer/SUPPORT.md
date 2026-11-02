# What each format supports

Generated from each codec's `support` by `cargo test -p finite-transfer`. Regenerate with `FINITE_UPDATE_FIXTURES=1`.

| Feature     | html import | html export |
| ----------- | ----------- | ----------- |
| frame       | exact       | exact       |
| text        | exact       | exact       |
| solid fill  | exact       | exact       |
| image       | exact       | exact       |
| flex layout | exact       | exact       |
| script      | opaque      | exact       |
| embed       | opaque      | unsupported |
