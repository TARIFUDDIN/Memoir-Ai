'use client'

import { Calendar, NotebookPen, Slack, CheckSquare, Trello, Server } from "lucide-react";

// Using closest available standard lucide icons for integrations
const tools = [
  { icon: Calendar, name: "Google Calendar" },
  { icon: Slack, name: "Slack" },
  { icon: CheckSquare, name: "Asana" },
  { icon: Server, name: "Jira" }, // Using Server as a placeholder for Jira
  { icon: Trello, name: "Trello" },
  { icon: NotebookPen, name: "Notion" },
];

export default function IntegrationsSection() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-6xl px-4 text-center">
        <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
          Seamless <span className="text-gradient">Integrations</span>
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
          Connect with the tools you already use and love.
        </p>

        <div className="relative mt-16 mx-auto max-w-3xl">
          <div className="absolute inset-0 grid place-items-center">
            <div className="h-40 w-40 rounded-full bg-gradient-to-br from-cyan-400/20 to-indigo-500/20 blur-3xl" />
          </div>
          <div className="relative grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
            {tools.map((t, i) => (
              <div
                key={t.name}
                className="glass-strong group flex aspect-square flex-col items-center justify-center rounded-2xl p-3 animate-float"
                style={{ animationDelay: `${i * 0.3}s` }}
              >
                <t.icon className="h-7 w-7 text-cyan-300 transition-transform group-hover:scale-110" />
                <span className="mt-2 text-xs text-muted-foreground">{t.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}