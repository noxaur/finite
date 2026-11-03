use std::sync::Arc;

use finite_server::{
    Hub,
    store::{FileStore, Store},
};

#[tokio::test]
async fn deletion_survives_concurrent_flush_and_restart() {
    let dir = std::env::temp_dir().join(format!("finite-delete-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(FileStore::new(&dir).unwrap());
    let hub = Hub::new(store.clone()).unwrap();
    let kept = hub.create("Keep");
    for _ in 0..20 {
        let design = hub.create("Draft");
        let handle = hub.get(&design.meta.id).unwrap();
        handle.rename("Unsaved changes".into());
        std::thread::scope(|scope| {
            scope.spawn(|| hub.flush());
            hub.delete(&handle).unwrap();
        });
        assert!(hub.get(&design.meta.id).is_none());
        assert!(store.load(&design.meta.id).unwrap().is_none());
        assert!(hub.delete(&handle).is_err());
    }
    hub.flush();
    let restored = Hub::new(store).unwrap();
    assert_eq!(restored.list().len(), 1);
    assert!(restored.get(&kept.meta.id).is_some());
    std::fs::remove_dir_all(dir).unwrap();
}
