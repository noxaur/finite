# What each format supports

Generated from each codec's `support` by `cargo test -p finite-transfer`. Regenerate with `FINITE_UPDATE_FIXTURES=1`.

| Feature        | html import | html export | finite import | finite export | figma import | figma export | jsx import  | jsx export  |
| -------------- | ----------- | ----------- | ------------- | ------------- | ------------ | ------------ | ----------- | ----------- |
| frame          | exact       | exact       | exact         | exact         | exact        | exact        | unsupported | exact       |
| text           | exact       | exact       | exact         | exact         | approximate  | approximate  | unsupported | exact       |
| solid fill     | exact       | exact       | exact         | exact         | exact        | exact        | unsupported | exact       |
| image          | exact       | exact       | exact         | exact         | exact        | approximate  | unsupported | exact       |
| flex layout    | exact       | exact       | exact         | exact         | exact        | approximate  | unsupported | exact       |
| script         | opaque      | exact       | opaque        | exact         | unsupported  | unsupported  | unsupported | unsupported |
| embed          | opaque      | unsupported | opaque        | unsupported   | unsupported  | unsupported  | unsupported | unsupported |
| import history | unsupported | unsupported | unsupported   | unsupported   | unsupported  | unsupported  | unsupported | unsupported |
