export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Post {slug}</h1>
    </main>
  );
}
