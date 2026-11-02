use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;

pub type NodeId = String;

/// One layer in a design. The tree mirrors the DOM: element nodes have a tag,
/// styles and attributes, and text nodes hold a string.
///
/// Top-level nodes (`parent: None`) are artboards. They are the only nodes with
/// a canvas position (`x`, `y`) and a `page`. Their size comes from their
/// `width` and `height` styles.
///
/// Serialized flat, as in `{"id": …, "type": "element", "tag": "div", …}`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    /// Fractional index among siblings (see [`crate::fractional`]).
    pub index: String,
    #[serde(flatten)]
    pub kind: NodeKind,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    /// The page an artboard is on (see [`crate::Page`]). `None`, or a page
    /// that no longer exists, means the design's first page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    #[serde(default)]
    pub styles: BTreeMap<String, String>,
    #[serde(default)]
    pub attrs: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NodeKind {
    Element { tag: String },
    Text,
}

/// Reads a node field by field. A derived `Deserialize` with
/// `#[serde(flatten)]` first buffers each node into a map of every field and
/// then reads it again. Reading the fields directly parses a 90,000-node
/// snapshot about 15% faster, which the browser feels on every open.
impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "lowercase")]
        enum Kind {
            Element,
            Text,
        }
        #[derive(Deserialize)]
        struct Wire {
            id: NodeId,
            parent: Option<NodeId>,
            index: String,
            #[serde(rename = "type")]
            kind: Kind,
            tag: Option<String>,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            text: Option<String>,
            #[serde(default)]
            x: Option<f64>,
            #[serde(default)]
            y: Option<f64>,
            #[serde(default)]
            page: Option<String>,
            #[serde(default)]
            styles: BTreeMap<String, String>,
            #[serde(default)]
            attrs: BTreeMap<String, String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let kind = match wire.kind {
            Kind::Element => NodeKind::Element {
                tag: wire.tag.ok_or_else(|| D::Error::missing_field("tag"))?,
            },
            Kind::Text => NodeKind::Text,
        };
        Ok(Node {
            id: wire.id,
            parent: wire.parent,
            index: wire.index,
            kind,
            name: wire.name,
            text: wire.text,
            x: wire.x,
            y: wire.y,
            page: wire.page,
            styles: wire.styles,
            attrs: wire.attrs,
        })
    }
}

impl Node {
    pub fn element(id: impl Into<NodeId>, tag: impl Into<String>) -> Self {
        Self::new(id.into(), NodeKind::Element { tag: tag.into() })
    }

    pub fn text(id: impl Into<NodeId>, text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            ..Self::new(id.into(), NodeKind::Text)
        }
    }

    fn new(id: NodeId, kind: NodeKind) -> Self {
        Self {
            id,
            parent: None,
            index: String::new(),
            kind,
            name: None,
            text: None,
            x: None,
            y: None,
            page: None,
            styles: BTreeMap::new(),
            attrs: BTreeMap::new(),
        }
    }

    pub fn tag(&self) -> Option<&str> {
        match &self.kind {
            NodeKind::Element { tag } => Some(tag),
            NodeKind::Text => None,
        }
    }

    pub fn is_artboard(&self) -> bool {
        self.parent.is_none()
    }

    /// The name shown in layer lists: the explicit name, else the tag or a text snippet.
    pub fn display_name(&self) -> String {
        if let Some(name) = &self.name {
            return name.clone();
        }
        match &self.kind {
            NodeKind::Element { tag } => tag.clone(),
            NodeKind::Text => {
                let text = self.text.as_deref().unwrap_or("").trim();
                let snippet: String = text.chars().take(24).collect();
                if snippet.len() < text.len() {
                    format!("{snippet}…")
                } else {
                    snippet
                }
            }
        }
    }

    pub fn get(&self, key: &PropKey) -> Option<Value> {
        match key {
            PropKey::Name => self.name.clone().map(Value::String),
            PropKey::Text => self.text.clone().map(Value::String),
            PropKey::X => self.x.map(Value::from),
            PropKey::Y => self.y.map(Value::from),
            PropKey::Page => self.page.clone().map(Value::String),
            PropKey::Style(k) => self.styles.get(k).cloned().map(Value::String),
            PropKey::Attr(k) => self.attrs.get(k).cloned().map(Value::String),
        }
    }

    /// Sets or clears one property. Fails if the value has the wrong type for the key.
    pub fn set(&mut self, key: &PropKey, value: Option<Value>) -> Result<(), PropError> {
        fn string(value: Option<Value>) -> Result<Option<String>, PropError> {
            match value {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) => Ok(Some(s)),
                Some(_) => Err(PropError::ExpectedString),
            }
        }
        fn number(value: Option<Value>) -> Result<Option<f64>, PropError> {
            match value {
                None | Some(Value::Null) => Ok(None),
                Some(Value::Number(n)) => n.as_f64().map(Some).ok_or(PropError::ExpectedNumber),
                Some(_) => Err(PropError::ExpectedNumber),
            }
        }
        fn put(map: &mut BTreeMap<String, String>, k: &str, v: Option<String>) {
            match v {
                Some(v) => map.insert(k.to_owned(), v),
                None => map.remove(k),
            };
        }
        match key {
            PropKey::Name => self.name = string(value)?,
            PropKey::Text => self.text = string(value)?,
            PropKey::X => self.x = number(value)?,
            PropKey::Y => self.y = number(value)?,
            PropKey::Page => self.page = string(value)?,
            PropKey::Style(k) => put(&mut self.styles, k, string(value)?),
            PropKey::Attr(k) => put(&mut self.attrs, k, string(value)?),
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropError {
    ExpectedString,
    ExpectedNumber,
}

/// Addresses one property of a node. Properties are the unit of conflict:
/// concurrent writes to the same property resolve last-writer-wins, and writes
/// to different properties of the same node both survive.
///
/// Serialized as `name`, `text`, `x`, `y`, `page`, `style:<css-property>` or
/// `attr:<attribute>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum PropKey {
    Name,
    Text,
    X,
    Y,
    Page,
    Style(String),
    Attr(String),
}

impl fmt::Display for PropKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Name => f.write_str("name"),
            Self::Text => f.write_str("text"),
            Self::X => f.write_str("x"),
            Self::Y => f.write_str("y"),
            Self::Page => f.write_str("page"),
            Self::Style(k) => write!(f, "style:{k}"),
            Self::Attr(k) => write!(f, "attr:{k}"),
        }
    }
}

impl From<PropKey> for String {
    fn from(key: PropKey) -> Self {
        key.to_string()
    }
}

impl TryFrom<String> for PropKey {
    type Error = String;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        Ok(match s.as_str() {
            "name" => Self::Name,
            "text" => Self::Text,
            "x" => Self::X,
            "y" => Self::Y,
            "page" => Self::Page,
            _ => match s.split_once(':') {
                Some(("style", k)) if !k.is_empty() => Self::Style(k.to_owned()),
                Some(("attr", k)) if !k.is_empty() => Self::Attr(k.to_owned()),
                _ => return Err(format!("unknown property key {s:?}")),
            },
        })
    }
}
