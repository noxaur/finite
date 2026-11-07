export default async function Shop({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Shop {slug ? slug.join(" / ") : "home"}</h1>
    </main>
  );
}
