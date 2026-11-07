export default async function Doc({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Docs: {slug.join(" / ")}</h1>
    </main>
  );
}
