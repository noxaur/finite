//! Imports as the journal sees them: one record that holds both the import
//! and its change, replayed safely any number of times.

use finite_design::{
    Design, DesignMeta, Node, Op, Record, Rejected, Snapshot,
    import::{BlobHash, ImportRecord},
    version,
};

fn design() -> Design {
    Design::new(DesignMeta {
        id: "d".into(),
        name: "Test".into(),
        created_at: 0,
        updated_at: 0,
    })
}

fn record(id: &str) -> ImportRecord {
    ImportRecord {
        id: id.into(),
        artifact: BlobHash::of(id.as_bytes()),
        format: "html".into(),
        input_kind: "html".into(),
        file_name: None,
        received_at: 1,
        nodes: Default::default(),
        dependencies: Vec::new(),
        quarantined: Vec::new(),
    }
}

fn board(id: &str) -> Op {
    let mut node = Node::element(id, "div");
    node.index = "V".into();
    Op::Create { node }
}

fn import(design: &mut Design, id: &str, ops: Vec<Op>) -> Record {
    let (change, ()) = design
        .import("agent", "Import", 1, |tx| {
            tx.apply(&ops)?;
            Ok::<_, Rejected>((record(id), ()))
        })
        .unwrap();
    Record::Import {
        import: design.imports().last().unwrap().clone(),
        change,
    }
}

#[test]
fn replaying_an_import_record_rebuilds_it_once() {
    let mut live = design();
    let journal = [
        import(&mut live, "i1", vec![board("a")]),
        import(&mut live, "i2", Vec::new()),
    ];
    let mut replayed = design();
    for _ in 0..2 {
        for record in journal.clone() {
            replayed.replay(record);
        }
    }
    assert_eq!(replayed.imports(), live.imports());
    assert_eq!(replayed.seq(), live.seq());
    assert!(replayed.doc().contains("a"));
    // The replayed import is still one undo step.
    replayed.undo("agent", 2).unwrap();
    assert!(replayed.doc().is_empty());
    assert_eq!(replayed.imports().len(), 2);
}

#[test]
fn imports_are_saved_but_not_sent_to_viewers() {
    let mut live = design();
    import(&mut live, "i1", vec![board("a")]);
    assert!(live.snapshot().imports.is_empty());
    let saved = live.snapshot_to_save();
    let json = version::SNAPSHOT.encode(&saved).unwrap();
    let restored = Design::from_snapshot(version::SNAPSHOT.decode::<Snapshot>(&json).unwrap());
    assert_eq!(restored.imports(), live.imports());
}

#[test]
fn records_and_snapshots_from_before_versions_still_read() {
    let unversioned =
        r#"{"type":"meta","meta":{"id":"d","name":"Old","createdAt":0,"updatedAt":0}}"#;
    let record: Record = version::RECORD.decode(unversioned).unwrap();
    assert!(matches!(record, Record::Meta { meta } if meta.name == "Old"));
    let snapshot =
        r#"{"meta":{"id":"d","name":"Old","createdAt":0,"updatedAt":0},"seq":3,"nodes":[]}"#;
    let snapshot: Snapshot = version::SNAPSHOT.decode(snapshot).unwrap();
    assert_eq!(snapshot.seq, 3);
    let newer = r#"{"v":99,"type":"meta"}"#;
    assert!(version::RECORD.decode::<Record>(newer).is_err());
}
