'use client';

import { Navbar } from "@/app/components/landing/Navbar";
import Footer from "@/app/components/landing/Footer";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const sections = [
  { id: "introduction", title: "Introduction" },
  { id: "core-problem", title: "The Core Problem: Corporate Amnesia" },
  { id: "why-current-fail", title: "Why Current Tools Fail" },
  { id: "the-solution", title: "The Solution & Devil's Advocate" },
  { id: "architecture", title: "System Architecture" },
  { id: "algorithms", title: "Core Algorithms" },
  { id: "evaluation", title: "Evaluations and Risks" },
  { id: "future", title: "Future Vision" },
];

export default function ResearchPage() {
  const [activeSection, setActiveSection] = useState("introduction");

  useEffect(() => {
    const handleScroll = () => {
      const scrollPosition = window.scrollY + 100;

      for (const section of [...sections].reverse()) {
        const element = document.getElementById(section.id);
        if (element && element.offsetTop <= scrollPosition) {
          setActiveSection(section.id);
          break;
        }
      }
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="min-h-screen bg-background dark selection:bg-cyan-500/30">
      <Navbar />

      {/* Hero Section */}
      <section className="pt-36 pb-16 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 rounded-full glass px-4 py-1.5 text-xs text-muted-foreground mb-6">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            Research Report
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
            MeetingBot is the new State-of-the-Art in{" "}
            <span className="text-gradient">Cognitive Intelligence</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10">
            A new cognitive architecture that solves corporate amnesia and context loss using Hybrid GraphRAG, 
            Temporal Sentiment Analysis, and an adversarial Devil's Advocate AI.
          </p>
          <div className="flex justify-center gap-4">
            <Button size="lg" className="bg-gradient-to-r from-cyan-400 to-indigo-500 text-background hover:opacity-90 glow" onClick={() => document.getElementById('introduction')?.scrollIntoView({ behavior: 'smooth' })}>
              Read Paper
            </Button>
            <Button size="lg" variant="outline" asChild className="border-white/15 bg-white/5 text-foreground hover:bg-white/10">
              <Link href="/home">Explore Dashboard <ArrowRight className="ml-2 w-4 h-4" /></Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Main Content Area */}
      <div className="max-w-6xl mx-auto px-4 py-12 flex flex-col md:flex-row gap-12 relative items-start">
        
        {/* Sticky Sidebar */}
        <aside className="hidden md:block w-64 shrink-0 sticky top-32">
          <div className="text-xs font-semibold tracking-wider text-muted-foreground mb-6 uppercase">
            Contents
          </div>
          <nav className="flex flex-col gap-3 border-l border-white/10 pl-4">
            {sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth' });
                }}
                className={cn(
                  "text-sm transition-colors",
                  activeSection === section.id
                    ? "text-cyan-400 font-medium"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {section.title}
              </a>
            ))}
          </nav>
        </aside>

        {/* Content Body */}
        <main className="flex-1 max-w-3xl prose prose-invert prose-cyan">
          
          <div className="glass-strong rounded-2xl p-6 mb-12 flex flex-col sm:flex-row gap-8 justify-between items-start sm:items-center">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Status</div>
              <div className="text-sm font-semibold">Production Ready</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Architecture</div>
              <div className="text-sm font-semibold">Hybrid GraphRAG + Temporal AI</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Performance</div>
              <div className="text-sm font-semibold">Near-zero context loss</div>
            </div>
          </div>

          <section id="introduction" className="scroll-mt-32">
            <h2 className="text-3xl font-bold tracking-tight mb-4">Introduction</h2>
            <p className="text-muted-foreground leading-relaxed mb-6">
              This report details the architectural foundation for "MeetingBot". The research tackles a massive problem in modern business: losing the valuable insights, arguments, and context that happen during spoken meetings.
            </p>
          </section>

          <hr className="border-white/10 my-10" />

          <section id="core-problem" className="scroll-mt-32">
            <h2 className="text-3xl font-bold tracking-tight mb-4">1. The Core Problem: "Corporate Amnesia"</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              The volume of video meetings has skyrocketed, but the audio generated is unstructured "dark data" that is notoriously difficult to search or analyze. We identify several critical failures:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-muted-foreground mb-6">
              <li><strong>Corporate Amnesia:</strong> The rapid decay of critical information after a meeting ends.</li>
              <li><strong>Loss of Context:</strong> Traditional meeting notes might record the final decision, but they lose the "why"—the rationale, debates, and dissenting opinions that led to that choice.</li>
              <li><strong>Information Silos:</strong> Meeting knowledge stays locked in attendees' heads, meaning different departments cannot algorithmically discover overlapping dependencies.</li>
              <li><strong>Subjective Bias:</strong> Human note-takers naturally filter information through their own biases, leading to disputes about accountability.</li>
            </ul>
          </section>

          <hr className="border-white/10 my-10" />

          <section id="why-current-fail" className="scroll-mt-32">
            <h2 className="text-3xl font-bold tracking-tight mb-4">2. Why Current Tools Fail</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Existing solutions are fundamentally inadequate for deep enterprise needs.
            </p>
            <ul className="list-disc pl-6 space-y-2 text-muted-foreground mb-6">
              <li><strong>Manual Notes:</strong> Resource-heavy, prone to human error, and prevent the note-taker from actually participating in the meeting.</li>
              <li><strong>Native Platform Recordings (Zoom/Teams):</strong> These create large video files with flat text transcripts considered "dead data" because it is not indexed for deep semantic meaning.</li>
              <li><strong>First-Generation AI (like Otter.ai):</strong> These tools use text-based LLMs and "Vector-Only RAG". They match themes well but fail at structural reasoning, treat meetings as isolated events, and often "hallucinate" or invent facts.</li>
            </ul>
          </section>

          <hr className="border-white/10 my-10" />

          <section id="the-solution" className="scroll-mt-32">
            <h2 className="text-3xl font-bold tracking-tight mb-4">3. The Solution: MeetingBot & The "Devil's Advocate"</h2>
            <p className="text-muted-foreground leading-relaxed mb-6">
              MeetingBot is an automated SaaS platform designed to fix these issues by shifting from passive recording to active intelligence. It understands the hierarchical relationships between decisions, personnel, and risks.
            </p>
            
            <div className="glass-strong rounded-xl p-6 mb-8 border-l-4 border-cyan-400">
              <h3 className="text-xl font-semibold mb-2 text-white">Combating Groupthink</h3>
              <p className="text-muted-foreground text-sm">
                A highly unique feature is the adversarial AI agent called the <strong>"Devil's Advocate"</strong>. This agent objectively flags logical fallacies and risks that human employees might be too scared to bring up to their bosses.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-6 mb-6">
              <div className="rounded-xl overflow-hidden border border-white/10">
                <Image src="/images/Risk Analysis.jpeg" alt="Risk Analysis" width={600} height={400} className="w-full h-auto object-cover" />
                <div className="bg-white/5 p-3 text-xs text-muted-foreground text-center">Devil's Advocate Risk Analysis View</div>
              </div>
              <div className="rounded-xl overflow-hidden border border-white/10">
                <Image src="/images/Knowledge graph.jpeg" alt="Knowledge Graph" width={600} height={400} className="w-full h-auto object-cover" />
                <div className="bg-white/5 p-3 text-xs text-muted-foreground text-center">Graph Database Relational View</div>
              </div>
            </div>
          </section>

          <hr className="border-white/10 my-10" />

          <section id="architecture" className="scroll-mt-32">
            <h2 className="text-3xl font-bold tracking-tight mb-4">4. System Architecture & Methodology</h2>
            <p className="text-muted-foreground leading-relaxed mb-6">
              The system is built on a modern tech stack (Next.js 15, AWS Lambda, Neo4j, Pinecone) and operates in three distinct phases:
            </p>

            <div className="space-y-6 mb-8">
              <div>
                <h4 className="text-lg font-semibold text-white mb-2">Phase 1: Ingestion (The "Ears")</h4>
                <p className="text-muted-foreground text-sm">The bot monitors a Google Calendar API, uses an AWS EventBridge scheduler to autonomously join the meeting via WebRTC, and captures real-time speech-to-text.</p>
              </div>
              <div>
                <h4 className="text-lg font-semibold text-white mb-2">Phase 2: Cognition (The "Brain")</h4>
                <p className="text-muted-foreground text-sm">Raw transcripts are pushed to a serverless message queue (Upstash QStash) to prevent data loss. A Worker API then splits the processing into three parallel tasks utilizing Vector Agents, Graph Agents, and Analyst Agents.</p>
              </div>
              <div>
                <h4 className="text-lg font-semibold text-white mb-2">Phase 3: Synthesis (The "Interface")</h4>
                <p className="text-muted-foreground text-sm">A frontend interface uses React Force Graph and Recharts to visualize the knowledge graph and emotional arcs, allowing users to query the bot via a chat interface.</p>
              </div>
            </div>

            <div className="rounded-xl overflow-hidden border border-white/10 bg-white/5 mb-6">
              <Image src="/images/meetingAI System Architecture.svg" alt="System Architecture" width={800} height={400} className="w-full h-auto" />
              <div className="bg-black/20 p-3 text-xs text-muted-foreground text-center">High-Level Serverless Architecture</div>
            </div>
          </section>

          <hr className="border-white/10 my-10" />

          <section id="algorithms" className="scroll-mt-32">
            <h2 className="text-3xl font-bold tracking-tight mb-4">5. Core Algorithms</h2>
            <p className="text-muted-foreground leading-relaxed mb-6">
              The intelligence of the bot relies on two primary algorithms that extract deep context from raw transcripts.
            </p>

            <div className="mb-8">
              <h3 className="text-xl font-semibold mb-3">Algorithm 1: Diarized Temporal Sentiment</h3>
              <p className="text-muted-foreground mb-4">
                This tracks the emotional journey of the meeting. It slices the transcript into 30-second windows, separates the text by speaker, and uses an LLM to score each speaker's sentiment from -1.0 to +1.0. Plotting these scores on a graph reveals visual "Conflict Events" when sentiment lines diverge.
              </p>
              <div className="rounded-xl overflow-hidden border border-white/10">
                <Image src="/images/Sentiment analysis.jpeg" alt="Sentiment Analysis Plot" width={800} height={400} className="w-full h-auto object-cover" />
                <div className="bg-white/5 p-3 text-xs text-muted-foreground text-center">Temporal Sentiment Visualization showing Conflict Events</div>
              </div>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-3">Algorithm 2: Hybrid RAG Retrieval</h3>
              <p className="text-muted-foreground mb-4">
                This classifies what the user is asking, then searches two paths simultaneously: Path A (Vector Search) for conceptual "vibe", and Path B (Graph Search) for hard factual relationships. It combines both results into one context block for the LLM to generate a grounded, hallucination-free answer.
              </p>
            </div>
          </section>

          <hr className="border-white/10 my-10" />

          <section id="evaluation" className="scroll-mt-32">
            <h2 className="text-3xl font-bold tracking-tight mb-4">6. Evaluations and Technical Risks</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              We rigorously evaluated the Hybrid approach against standard AI models. The results demonstrate that Hybrid GraphRAG vastly outperforms Vector-Only RAG in Faithfulness, Answer Relevance, and exact entity relationship recall.
            </p>
            <p className="text-muted-foreground leading-relaxed mb-6">
              To mitigate risks such as Model Hallucination, Data Drift, and Graph Inconsistency, we implemented strict <strong>Grounding Protocols</strong> (forcing the AI to only use retrieved context) and fallback logics to prevent false positive answers.
            </p>
          </section>

          <hr className="border-white/10 my-10" />

          <section id="future" className="scroll-mt-32">
            <h2 className="text-3xl font-bold tracking-tight mb-4">7. Future Vision</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Our continuous research roadmap aims to make the system even more robust:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
              <li><strong>On-Device Processing:</strong> Moving AI processing directly to the user's browser using WebAssembly to keep sensitive data completely private and off the cloud.</li>
              <li><strong>Voice Biometrics:</strong> Automatically recognizing and tagging specific users based on their voice across different meetings.</li>
              <li><strong>Predictive Analytics:</strong> Using historical Knowledge Graph data to predict if future projects will be delayed based on past meeting trends.</li>
            </ul>
          </section>

        </main>
      </div>

      <Footer />
    </div>
  );
}
