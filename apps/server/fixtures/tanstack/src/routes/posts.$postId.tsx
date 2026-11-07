import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/posts/$postId")({
  component: Post,
});

function Post() {
  const { postId } = Route.useParams();
  return <h1>Post {postId}</h1>;
}
