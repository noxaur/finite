import mark from "../assets/brand/mark.svg";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-8 py-10">
      <header className="flex items-center gap-3">
        <img src={mark} alt="" className="size-8" />
        <span className="text-sm font-medium tracking-wide">Untitled</span>
      </header>

      <section className="flex flex-1 flex-col justify-center gap-6 py-24">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">A new design</p>
        <h1 className="max-w-3xl font-display text-6xl leading-[1.05] tracking-tight">
          Start with a sentence that says what this is for.
        </h1>
        <p className="max-w-xl text-lg text-muted">
          Ask an agent to shape this page, or edit it by hand on the canvas. Every change is plain
          React and Tailwind in your project.
        </p>
        <div className="flex gap-3 pt-2">
          <a href="#" className="rounded-card bg-ink px-5 py-3 text-sm font-medium text-paper">
            Get started
          </a>
          <a href="#" className="rounded-card px-5 py-3 text-sm font-medium ring-1 ring-ink/15">
            Learn more
          </a>
        </div>
      </section>
    </main>
  );
}
