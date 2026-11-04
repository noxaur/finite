//! Pages: named groups of artboards. The viewer shows one page at a time, so
//! a design can keep components and drafts away from its screens. Pages
//! live in the document (`Op::Page`), so they're saved, synced to viewers
//! and undoable like any edit.

use finite_design::edit;
use rmcp::{
    RoleServer, handler::server::wrapper::Parameters, service::RequestContext, tool, tool_router,
};

use super::{FiniteMcp, ToolResult, changed, describe, params::*};
use crate::hub::random_id;

pub(super) const INSTRUCTIONS: &str = "Pages: people see one page at a time. To keep drafts away from the screens, create_page, then create_artboard with its pageId or move_to_page. get_basic_info lists the pages.";

#[tool_router(router = pages_router, vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        description = "Add a page to the design, after the others. People see one page at a time, so use pages to keep components, drafts or flows apart. Returns its pageId; pass it to create_artboard or move_to_page."
    )]
    async fn create_page(
        &self,
        Parameters(p): Parameters<CreatePageParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let label = format!("Create page {:?}", p.name);
        self.edit(
            &ctx,
            &p.design_id,
            &label,
            |doc| {
                let id = loop {
                    let id = random_id(8);
                    if doc.page(&id).is_none() {
                        break id;
                    }
                };
                Ok((edit::create_page(doc, id.clone(), &p.name)?, id))
            },
            |_, id, _| {
                format!("Created the page, pageId {id:?}. Next: create_artboard with that pageId.")
            },
        )
        .await
    }

    #[tool(description = "Rename a page.")]
    async fn rename_page(
        &self,
        Parameters(p): Parameters<RenamePageParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Rename page",
            |doc| Ok((edit::rename_page(doc, &p.page_id, &p.name)?, ())),
            |_, (), change| describe(change).into(),
        )
        .await
    }

    #[tool(
        description = "Delete a page and every artboard on it. To keep its artboards, move_to_page them first. A design keeps at least one page."
    )]
    async fn delete_page(
        &self,
        Parameters(p): Parameters<PageParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Delete page",
            |doc| {
                let ops = edit::delete_page(doc, &p.page_id)?;
                let boards = ops.len() - 1;
                Ok((ops, boards))
            },
            |_, boards, _| match boards {
                0 => "Deleted the page.".into(),
                n => format!(
                    "Deleted the page and its {n} artboard{}.",
                    if n == 1 { "" } else { "s" }
                ),
            },
        )
        .await
    }

    #[tool(
        description = "Move artboards to another page, into free space to the right of what's there."
    )]
    async fn move_to_page(
        &self,
        Parameters(p): Parameters<MoveToPageParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Move artboards to page",
            |doc| Ok((edit::move_to_page(doc, &p.artboard_ids, &p.page_id)?, ())),
            |handle, (), change| changed(handle, change, p.artboard_ids.len()),
        )
        .await
    }
}
