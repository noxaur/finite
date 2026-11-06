# What each format supports

Generated from each codec's `support` by `cargo test -p finite-transfer`. Regenerate with `FINITE_UPDATE_FIXTURES=1`.

| Feature            | html import | html export | finite import | finite export | figma import | figma export | jsx import  | jsx export  | repo import | repo export | app import  | app export  |
| ------------------ | ----------- | ----------- | ------------- | ------------- | ------------ | ------------ | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| frame              | exact       | exact       | exact         | exact         | exact        | exact        | unsupported | approximate | exact       | exact       | unsupported | approximate |
| text               | exact       | exact       | exact         | exact         | approximate  | approximate  | unsupported | exact       | exact       | exact       | unsupported | exact       |
| solid fill         | exact       | exact       | exact         | exact         | exact        | exact        | unsupported | approximate | exact       | exact       | unsupported | approximate |
| image              | exact       | exact       | exact         | exact         | exact        | approximate  | unsupported | exact       | exact       | exact       | unsupported | exact       |
| flex layout        | exact       | exact       | exact         | exact         | exact        | approximate  | unsupported | approximate | exact       | exact       | unsupported | approximate |
| script             | opaque      | exact       | opaque        | exact         | unsupported  | unsupported  | unsupported | unsupported | opaque      | exact       | unsupported | unsupported |
| embed              | opaque      | unsupported | opaque        | unsupported   | unsupported  | unsupported  | unsupported | unsupported | opaque      | unsupported | unsupported | unsupported |
| import history     | unsupported | unsupported | unsupported   | unsupported   | unsupported  | unsupported  | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| component instance | unsupported | approximate | unsupported   | approximate   | unsupported  | approximate  | unsupported | approximate | unsupported | approximate | unsupported | approximate |
