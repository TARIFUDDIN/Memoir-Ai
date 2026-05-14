'use client'

import { Download, Settings2, LineChart } from "lucide-react";

const items = [
  { icon: Download, title: "Complete Meeting Exports", body: "Download audio MP3, transcripts, summaries, and action items." },
  { icon: Settings2, title: "Full Customization", body: "Customize bot name, image and toggle bot participation." },
  { icon: LineChart, title: "Meeting Analytics", body: "Track meeting patterns, participation rates, and productivity." },
];

export default function MoreFeaturesSection() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-6xl px-4">
        <div className="text-center">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
            Plus <span className="text-gradient">More Features</span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            Everything you need for complete meeting management
          </p>
        </div>
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {items.map((i) => (
            <div key={i.title} className="glass-strong rounded-2xl p-6">
              <i.icon className="h-6 w-6 text-cyan-300" />
              <h3 className="mt-4 font-semibold">{i.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{i.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}