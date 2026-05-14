'use client'

import { CalendarDays, Mail, MessageSquare, PlusSquare, Share2, Workflow } from "lucide-react";

const features = [
  { icon: PlusSquare, title: "AI Meeting Summaries", body: "Automatic meeting summaries and action items after each meeting." },
  { icon: CalendarDays, title: "Smart Calendar Integration", body: "Connect Google Calendar and bots automatically join meetings." },
  { icon: Mail, title: "Automated Email Reports", body: "Receive beautiful email summaries with action items." },
  { icon: MessageSquare, title: "Chat with Meetings", body: "Ask questions about meetings using our RAG pipeline." },
  { icon: Share2, title: "One-Click Integrations", body: "Push action items to Slack, Asana, Jira and Trello." },
  { icon: Workflow, title: "Slack bot Integration", body: "Install our Slack Bot to ask questions and share insights." },
];

export default function FeaturesSection() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mt-20 text-center">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
            Everything you need for <span className="text-gradient">Smarter Meetings</span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            From AI summaries to seamless integrations, we've got every aspect covered.
          </p>
        </div>

        <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="glass-strong rounded-2xl p-6 transition-all hover:-translate-y-1 hover:shadow-[0_0_40px_-10px_oklch(0.72_0.18_220/0.4)]">
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-cyan-400/20 to-indigo-500/20 text-cyan-300">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}