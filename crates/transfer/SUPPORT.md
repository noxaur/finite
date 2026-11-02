# What each format supports

Generated from each codec's `support` by `cargo test -p finite-transfer`. Regenerate with `FINITE_UPDATE_FIXTURES=1`.

| Feature        | html import | html export | finite import | finite export | figma import | figma export |
| -------------- | ----------- | ----------- | ------------- | ------------- | ------------ | ------------ |
| frame          | exact       | exact       | exact         | exact         | exact        | exact        |
| text           | exact       | exact       | exact         | exact         | approximate  | approximate  |
| solid fill     | exact       | exact       | exact         | exact         | exact        | exact        |
| image          | exact       | exact       | exact         | exact         | exact        | approximate  |
| flex layout    | exact       | exact       | exact         | exact         | exact        | approximate  |
| script         | opaque      | exact       | opaque        | exact         | unsupported  | unsupported  |
| embed          | opaque      | unsupported | opaque        | unsupported   | unsupported  | unsupported  |
| import history | unsupported | unsupported | unsupported   | unsupported   | unsupported  | unsupported  |
