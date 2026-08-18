import { createFileRoute } from "@tanstack/react-router";
import { Binary, Bug, FileSearch, Terminal } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CodeCracks — Bot Reverse Engineering Telegram" },
      {
        name: "description",
        content:
          "CodeCracks adalah bot Telegram bertenaga Qwen AI untuk analisa reverse engineering: disassembly, hex dump, binary, dan bytecode.",
      },
      { property: "og:title", content: "CodeCracks — Bot Reverse Engineering Telegram" },
      {
        property: "og:description",
        content:
          "Kirim kode, hex dump, atau file binary ke bot Telegram CodeCracks dan dapatkan analisa reverse engineering dari Qwen AI.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const features = [
  {
    icon: Terminal,
    title: "Tanya jawab RE",
    body: "Disassembly x86/ARM, decompiler output, packer, obfuscation, debugging.",
  },
  {
    icon: Binary,
    title: "Analisa binary",
    body: "Hex dump + string extraction otomatis untuk PE, ELF, Mach-O, DEX, firmware.",
  },
  {
    icon: FileSearch,
    title: "Analisa file & kode",
    body: "Kirim file sampai 5 MB atau tempel snippet, bot balas breakdown teknis.",
  },
  {
    icon: Bug,
    title: "Crackme & CTF",
    body: "Bantuan langkah demi langkah untuk tantangan RE edukasional.",
  },
];

function Index() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
          telegram bot · qwen ai
        </p>
        <h1 className="mt-4 font-mono text-4xl font-bold tracking-tight sm:text-5xl">
          CodeCracks
        </h1>
        <p className="mt-4 max-w-xl text-muted-foreground">
          Bot Telegram khusus Reverse Engineering. Kirim pertanyaan, kode, hex dump, atau file
          binary — jawaban teknis datang dari Qwen AI.
        </p>

        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-lg border border-border bg-card p-5">
              <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
              <h2 className="mt-3 font-mono text-sm font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>

        <section className="mt-12 rounded-lg border border-dashed border-border p-5">
          <h2 className="font-mono text-sm font-semibold">Cara pakai</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Buka bot di Telegram lalu kirim /start.</li>
            <li>Tulis pertanyaan RE, atau lampirkan file/kode.</li>
            <li>Bot menjawab dengan analisa dan langkah lanjutan.</li>
          </ol>
        </section>
      </div>
    </main>
  );
}
