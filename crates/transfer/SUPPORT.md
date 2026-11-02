# What each format supports

Generated from each codec's `support` by `cargo test -p finite-transfer`. Regenerate with `FINITE_UPDATE_FIXTURES=1`.

| Feature        | html import | html export | finite import | finite export |
| -------------- | ----------- | ----------- | ------------- | ------------- |
| frame          | exact       | exact       | exact         | exact         |
| text           | exact       | exact       | exact         | exact         |
| solid fill     | exact       | exact       | exact         | exact         |
| image          | exact       | exact       | exact         | exact         |
| flex layout    | exact       | exact       | exact         | exact         |
| script         | opaque      | exact       | opaque        | exact         |
| embed          | opaque      | unsupported | opaque        | unsupported   |
| import history | unsupported | unsupported | unsupported   | unsupported   |
