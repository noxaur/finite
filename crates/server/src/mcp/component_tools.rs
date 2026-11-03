//! Components: one definition that instances on every artboard follow, so
//! a top bar shared by five screens changes in one edit. The tools ship
//! when `FINITE_MCP_EXTRA` includes `components`, so AX runs (`e2e/ax`) can
//! measure them before every agent gets them. The document model is in
//! `finite_design::components`, and edits inside instances become
//! overrides whether or not the tools are on.

use finite_design::{
    Document, Node,
    components::is_virtual,
    edit::{self, InstanceValues},
};
use rmcp::{
    handler::server::wrapper::Parameters,
    service::{RequestContext, RoleServer},
    tool, tool_router,
};

use super::{FiniteMcp, ToolResult, cut, fit, id_in, ok, outline, params::*, with_note};

pub(super) const INSTRUCTIONS: &str = "Components: repeat data-component=\"Top bar\"; the first defines it, later ones are instances. Edit the first to change all.";

/// How many instances get_components lists for each component.
const INSTANCES_SHOWN: usize = 50;

#[tool_router(router = component_router, vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        description = "Make an element a component: one definition that instances follow, like a top bar every screen shows. It stays where it is, and editing it changes every instance. Pass replaceNodeIds to turn copies of it on other screens into instances in place: where a copy's text, styles or attributes differ, they become that instance's overrides."
    )]
    async fn create_component(
        &self,
        Parameters(p): Parameters<CreateComponentParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let label = format!(
            "Create component {:?}",
            p.name.as_deref().unwrap_or(&p.node_id)
        );
        let id = p.node_id.clone();
        let replaced = p.replace_node_ids.clone();
        self.edit(
            &ctx,
            &p.design_id,
            &label,
            |doc| {
                let ops = edit::create_component(
                    doc,
                    &p.node_id,
                    p.name.as_deref(),
                    &p.replace_node_ids,
                )?;
                Ok((ops, ()))
            },
            |handle, (), _| {
                handle.read(|d| {
                    let doc = d.view();
                    let Some(node) = doc.get(&id) else {
                        return format!("#{id} is gone.");
                    };
                    let mut text = format!(
                        "#{id} {:?} is a component. Edit it, or anything inside it, to change every instance.",
                        node.display_name()
                    );
                    if !replaced.is_empty() {
                        text.push_str(&format!(
                            "\nReplaced {} cop{} with instances, keeping their ids:",
                            replaced.len(),
                            if replaced.len() == 1 { "y" } else { "ies" }
                        ));
                        for r in &replaced {
                            let overrides = d.doc().get(r).map_or(0, |n| n.overrides.len());
                            text.push_str(&format!(
                                "\n  #{r}: {overrides} override{}",
                                if overrides == 1 { "" } else { "s" }
                            ));
                        }
                    }
                    text.push_str(&format!(
                        "\nInside an instance, ids look like {}/<id>: editing those changes only that instance.",
                        replaced.first().map_or("<instanceId>", String::as_str)
                    ));
                    let outside = classes_styled_outside(d.doc(), &id);
                    if !outside.is_empty() {
                        text.push_str(&format!(
                            "\nIts classes {} are styled by <style> blocks outside it. A <style> only styles its own artboard, so instances elsewhere don't follow changes to those rules. Move the rules into a <style> inside the component, or style it inline with tokens (set_tokens).",
                            outside.iter().map(|c| format!(".{c}")).collect::<Vec<_>>().join(", ")
                        ));
                    }
                    text
                })
            },
        )
        .await
    }

    #[tool(
        description = "Put an instance of a component into an element: a copy that follows the component, so editing the component changes it too. Pass overrides for what this one shows differently, like its title. Returns its outline, whose ids (instanceId/nodeId) edit only this instance."
    )]
    async fn insert_instance(
        &self,
        Parameters(p): Parameters<InsertInstanceParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let values: Vec<InstanceValues> = p
            .overrides
            .iter()
            .map(|o| InstanceValues {
                node_id: o.node_id.clone(),
                text: o.text.clone(),
                styles: o.styles.clone(),
                attributes: o.attributes.clone(),
            })
            .collect();
        self.edit(
            &ctx,
            &p.design_id,
            "Insert instance",
            |doc| {
                edit::insert_instance(
                    doc,
                    &p.component_id,
                    &p.parent_id,
                    p.index,
                    p.name.as_deref(),
                    &values,
                    &mut id_in(doc),
                )
            },
            |handle, id, _| {
                handle.read(|d| {
                    let doc = d.view();
                    let mut text = format!("Inserted instance #{id}:\n");
                    text.push_str(&outline(doc, &id, 3));
                    cut(text, "Call get_tree_summary on it to see the rest.")
                })
            },
        )
        .await
    }

    #[tool(
        description = "The design's components: each one's id, name, artboard, outline, and its instances with how many values each overrides.",
        annotations(read_only_hint = true)
    )]
    async fn get_components(&self, Parameters(p): Parameters<DesignParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let list: Vec<serde_json::Value> = handle.read(|d| {
            let doc = d.doc();
            let view = d.view();
            let mut found: Vec<_> = doc.nodes().filter(|n| n.component).collect();
            found.sort_by(|a, b| {
                a.display_name()
                    .cmp(&b.display_name())
                    .then(a.id.cmp(&b.id))
            });
            found
                .into_iter()
                .map(|c| {
                    let instances: Vec<_> = doc.instances_of(&c.id).collect();
                    let listed: Vec<serde_json::Value> = instances
                        .iter()
                        .take(INSTANCES_SHOWN)
                        .filter_map(|id| doc.get(id))
                        .map(|i| {
                            serde_json::json!({
                                "id": i.id,
                                "artboardId": doc.artboard_of(&i.id).map(|a| &a.id),
                                "overrides": i.overrides.len(),
                            })
                        })
                        .collect();
                    serde_json::json!({
                        "id": c.id,
                        "name": c.display_name(),
                        "artboardId": doc.artboard_of(&c.id).map(|a| &a.id),
                        "outline": outline(view, &c.id, 2),
                        "instanceCount": instances.len(),
                        "instances": listed,
                    })
                })
                .collect()
        });
        if list.is_empty() {
            return ok(
                "This design has no components. Make one from an element with create_component.",
            );
        }
        let total = list.len();
        let (content, shown) = fit(list.into_iter());
        Ok(rmcp::model::CallToolResult::success(with_note(
            content,
            (shown < total).then(|| format!("Showing {shown} of {total} components.")),
        )))
    }

    #[tool(
        description = "Turn instances into plain copies of what they show, with their overrides applied. They stop following their component; the component and its other instances don't change."
    )]
    async fn detach_instance(
        &self,
        Parameters(p): Parameters<NodesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let ids = p.node_ids.clone();
        self.edit(
            &ctx,
            &p.design_id,
            "Detach instance",
            |doc| {
                let ops = edit::detach_instances(doc, &p.node_ids, &mut id_in(doc))?;
                Ok((ops, ()))
            },
            |handle, (), change| {
                if change.is_none() {
                    return "Nothing changed.".into();
                }
                handle.read(|d| {
                    let mut text = String::from("Detached:\n");
                    for id in ids.iter().filter(|id| !is_virtual(id)) {
                        text.push_str(&outline(d.view(), id, 2));
                    }
                    cut(text, "Call get_tree_summary on one to see the rest.")
                })
            },
        )
        .await
    }
}

/// The classes used inside component `id` that a `<style>` block in its
/// artboard, outside the component, mentions. Instances on other
/// artboards don't get those rules.
fn classes_styled_outside(doc: &Document, id: &str) -> Vec<String> {
    let inside: Vec<&Node> = doc.subtree(id);
    let mut classes: Vec<String> = inside
        .iter()
        .filter_map(|n| n.attrs.get("class"))
        .flat_map(|c| c.split_whitespace().map(str::to_owned))
        .collect();
    classes.sort();
    classes.dedup();
    let Some(board) = doc.artboard_of(id) else {
        return Vec::new();
    };
    let css: String = doc
        .subtree(&board.id)
        .into_iter()
        .filter(|n| n.tag().is_some_and(|t| t.eq_ignore_ascii_case("style")))
        .filter(|n| n.id != id && !doc.is_ancestor(id, &n.id))
        .flat_map(|n| doc.children(Some(&n.id)))
        .filter_map(|t| t.text.as_deref())
        .collect();
    classes
        .into_iter()
        .filter(|c| {
            let selector = format!(".{c}");
            css.match_indices(&selector).any(|(at, _)| {
                // `.bar` shouldn't match `.barrel`.
                !css[at + selector.len()..]
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_alphanumeric() || ch == '-' || ch == '_')
            })
        })
        .collect()
}
