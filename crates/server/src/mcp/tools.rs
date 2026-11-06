//! The six tools agents see. Each is a declaration (name, description,
//! hints) that hands its parameters to the module that does the work.

use rmcp::{
    RoleServer, handler::server::wrapper::Parameters, service::RequestContext, tool, tool_router,
};

use super::{
    FiniteMcp,
    comments::{self, CommentsParams},
    designs::DesignsParams,
    edit::EditParams,
    read::{self, ReadParams},
    render::{self, RenderParams},
    result::ToolResult,
    undo::{self, UndoParams},
};

const EDIT_DESCRIPTION: &str = include_str!("edit.md");
const READ_DESCRIPTION: &str = include_str!("read.md");

#[tool_router(vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        name = "designs",
        description = "List, create, rename or delete designs, latest edit first. delete is permanent; to remove an artboard, use edit's remove op.",
        annotations(read_only_hint = false)
    )]
    async fn designs_tool(&self, Parameters(p): Parameters<DesignsParams>) -> ToolResult {
        self.designs(p).await
    }

    #[tool(
        name = "read",
        description = READ_DESCRIPTION,
        annotations(read_only_hint = true)
    )]
    async fn read_tool(
        &self,
        Parameters(p): Parameters<ReadParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        read::read(self, &handle, &self.actor(&ctx), p).await
    }

    #[tool(
        name = "edit",
        description = EDIT_DESCRIPTION,
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn edit_tool(
        &self,
        Parameters(p): Parameters<EditParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        self.edit(&handle, &self.actor(&ctx), p).await
    }

    #[tool(
        name = "render",
        description = "An image of what select matches (default: every artboard), with a layout check. output: \"layout\" returns each element's box as text instead, more cheaply. Render after building a section to see it; scale: 2 helps read small text.",
        annotations(read_only_hint = true)
    )]
    async fn render_tool(&self, Parameters(p): Parameters<RenderParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        render::render(&handle, p).await
    }

    #[tool(
        name = "comments",
        description = "Comments people pinned to a design. The server sends each to one agent.\n\n- {\"designId\": \"…\"}: open comments. Act only on those whose \"for\" is \"you\".\n- {\"designId\": \"…\", \"wait\": 55}: blocks until one is waiting for you; loop on it to keep taking feedback.\n- {\"designId\": \"…\", \"reply\": [{\"commentId\": \"…\", \"message\": \"Made it a link.\", \"resolve\": true}]}: say what you changed, or ask and leave it open.\n\npass hands a comment you can't take to another agent; forPeople marks a note between people, so no agent acts on it.",
        annotations(read_only_hint = false)
    )]
    async fn comments_tool(
        &self,
        Parameters(p): Parameters<CommentsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        comments::comments(self, &handle, &self.actor(&ctx), p).await
    }

    #[tool(
        name = "undo",
        description = "Undo your last edit calls, one call per step; never other agents' changes. redo: true redoes.",
        annotations(read_only_hint = false)
    )]
    async fn undo_tool(
        &self,
        Parameters(p): Parameters<UndoParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        undo::undo(&handle, &self.actor(&ctx), p)
    }
}
