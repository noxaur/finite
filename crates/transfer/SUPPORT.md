# What each format supports

Generated from each codec's `support` by `cargo test -p finite-transfer`. Regenerate with `FINITE_UPDATE_FIXTURES=1`.

| Feature        | html import | html export | finite import | finite export | figma import | figma export | jsx import  | jsx export  | repo import | repo export |
| -------------- | ----------- | ----------- | ------------- | ------------- | ------------ | ------------ | ----------- | ----------- | ----------- | ----------- |
| frame          | exact       | exact       | exact         | exact         | exact        | exact        | unsupported | approximate | exact       | exact       |
| text           | exact       | exact       | exact         | exact         | approximate  | approximate  | unsupported | exact       | exact       | exact       |
| solid fill     | exact       | exact       | exact         | exact         | exact        | exact        | unsupported | approximate | exact       | exact       |
| image          | exact       | exact       | exact         | exact         | exact        | approximate  | unsupported | exact       | exact       | exact       |
| flex layout    | exact       | exact       | exact         | exact         | exact        | approximate  | unsupported | approximate | exact       | exact       |
| script         | opaque      | exact       | opaque        | exact         | unsupported  | unsupported  | unsupported | unsupported | opaque      | exact       |
| embed          | opaque      | unsupported | opaque        | unsupported   | unsupported  | unsupported  | unsupported | unsupported | opaque      | unsupported |
| import history | unsupported | unsupported | unsupported   | unsupported   | unsupported  | unsupported  | unsupported | unsupported | unsupported | unsupported |
