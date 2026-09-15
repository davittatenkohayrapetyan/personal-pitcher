# Davit Hayrapetyan – Professional Profile

## Summary

Davit Hayrapetyan is a Staff Software Engineer and architecture-oriented backend engineer based in Yerevan, Armenia.

With more than 13 years of software engineering experience, Davit specializes in distributed systems, microservices modernization, resilient backend architectures, cloud-native applications, and enterprise integrations. His core expertise lies in Java and Kotlin ecosystems, with strong experience in Spring Boot, observability, scalability, and high-load backend systems.

Alongside hands-on engineering, Davit actively contributes to:
- system design and architecture
- technical leadership
- mentoring and onboarding
- engineering interviews
- stakeholder communication
- developer community building

He combines deep technical expertise with strong communication skills, making him effective both as an engineer and as a technical leader capable of bridging business and engineering domains.

Outside traditional enterprise engineering, Davit is also deeply interested in:
- AI agents
- developer tooling
- retrieval augmented generation (RAG)
- intelligent automation
- community education
- creative technology

Davit is also:
- organizer of major developer community events in Armenia
- university lecturer
- electronic music producer under the alias "Shepard D"

---

## Engineering Range

Davit's work is architecture-first rather than language-first. The JVM is where
he has spent the most years, but it is not the boundary of his experience:

- **C++, QT and Verilog** — five years at Synopsys (2015–2020) on embedded
  memory testing and repair systems, silicon production analysis tooling, and
  performance-sensitive low-level software.
- **Kotlin** — governmental mobile driver-license platform at jambit (2024).
- **TypeScript, Angular and React** — frontend modules on the driver-license
  platform, and the Next.js/React application serving this site.
- **Search and data systems** — led a relational-to-Elasticsearch migration at
  Novanoweb, tuning aggregation and search performance for e-commerce scale.
- **Python and Go** — used in tooling and community work rather than as a
  primary production language.

The through-line across all of it is system design under constraints:
resilience, throughput, observability and integration — the parts of the job
that survive a change of language.

## Ownership

Examples of work Davit personally led rather than contributed to:

- Leading the modernization of the Raymond James wealth-management platform
  from legacy monoliths to resilient microservices (Grid Dynamics, 2025–).
- Leading development of a governmental mobile driver-license platform,
  including enrollment, encryption and document workflows (jambit, 2024).
- Leading enterprise Java synchronization systems for automotive material
  verification, and the reliability/architecture improvements to them
  (jambit, 2023–2024).
- Leading the migration from relational databases to Elasticsearch and the
  resulting search-performance work (Novanoweb, 2020–2021).
- Proposing and helping standardize state-machine-driven orchestration for
  omnichannel survey microservices (Talkdesk, 2021–2022).
- Founding and running GDG Yerevan as organizer since 2022.

---

# Experience

## Grid Dynamics — Staff Software Engineer
**January 2025 – Present**

Project: Raymond James Wealth Management Platform

Responsibilities:
- Leading modernization of a mission-critical wealth-management platform
- Transitioning legacy monoliths into resilient microservices
- Designing observability and resiliency improvements
- Integrating vendor APIs and enterprise systems
- Performance optimization using Redis and intelligent caching strategies
- Supporting architectural alignment between engineering, DevOps, DB, and product teams

Key Technologies:
- Java 17
- Spring Boot
- Redis
- IBM MQ
- OracleDB
- OpenTelemetry
- Splunk
- Docker
- Jenkins

Highlights:
- Implemented resiliency patterns preventing cascading failures
- Designed fallback strategies and observability improvements
- Led integration analysis for third-party financial data providers

---

## jambit.am LLC — Principal Java Developer / Architect
**March 2024 – January 2025**

Project: Governmental Mobile Driver License Platform

Responsibilities:
- Led development of a resilient microservices platform
- Designed REST APIs and backend services
- Developed Angular frontend modules
- Managed AWS and Docker Swarm deployments
- Worked on enrollment, encryption, and document workflows

Key Technologies:
- Kotlin
- Java 21
- Spring Boot
- Angular
- MongoDB
- AWS
- Docker Swarm

---

## jambit.am LLC — Senior Software Architect
**March 2023 – March 2024**

Project: Automotive Material Verification

Responsibilities:
- Led enterprise Java synchronization systems
- Improved system reliability and architecture
- Enhanced material verification workflows

Key Technologies:
- Java EE
- Payara
- OracleDB
- Azure
- Swing
- Angular

---

## Talkdesk — Senior Software Engineer
**July 2021 – October 2022**

Project: Interactive Post-Survey Experience

Responsibilities:
- Designed scalable omnichannel survey microservices
- Proposed state-machine-driven orchestration flows
- Researched workflow and state-machine solutions
- Helped standardize orchestration architecture

Key Technologies:
- Java 16
- Spring Boot
- Redis
- Kafka
- Docker
- Jenkins

---

## Novanoweb Solutions — Senior Software Engineer
**August 2020 – July 2021**

Responsibilities:
- Led migration from relational databases to Elasticsearch
- Optimized aggregation and search performance
- Improved scalability of e-commerce systems

Key Technologies:
- Java
- Spring Boot
- Elasticsearch
- MariaDB
- PostgreSQL

---

## Synopsys — Senior Software Engineer
**August 2015 – August 2020**

Responsibilities:
- Developed embedded memory testing and repair systems
- Worked on silicon production analysis tooling
- Built performance-sensitive low-level software

Key Technologies:
- C++
- QT
- Verilog

---

## Inomma — Senior Software Engineer
**April 2015 – July 2015**

Responsibilities:
- Developed automated cloud-based competitor pricing scrapers

Key Technologies:
- Java
- Spring Boot
- AWS

---

## Synergy International Systems — Software Engineer
**September 2011 – April 2015**

Responsibilities:
- Enhanced CMS platforms for government organizations
- Integrated web and desktop systems

Key Technologies:
- Java EE
- JavaScript
- jQuery
- MySQL
- Swing
- JSP

---

## Education

### PhD in Engineering
Yerevan State University  
2019

### Master in Development of Information Systems
Yerevan State University  
2016

---

## Skills

### Backend Engineering
- Java
- Kotlin
- Spring Boot
- Java EE
- Hibernate
- Quarkus
- REST APIs
- Distributed Systems
- Microservices

### Cloud & DevOps
- AWS
- Azure
- Docker
- Docker Swarm
- CI/CD
- Jenkins
- OpenTelemetry
- Splunk

### Databases & Messaging
- OracleDB
- PostgreSQL
- MongoDB
- Redis
- Elasticsearch
- Kafka
- IBM MQ

### Frontend
- Angular
- TypeScript
- React (basic/full-stack integrations)

### Leadership & Communication
- System Design
- Technical Leadership
- Mentorship
- Architecture Discussions
- Stakeholder Communication
- Developer Community Organization

### AI & Emerging Technologies
- AI Agents
- RAG Systems
- AI-assisted Developer Tooling
- Local LLM experimentation
- Intelligent Automation

---

## This Website (Personal Pitcher)

The site answering this question is built and operated by Davit, and is a
deliberate demonstration of how he builds AI systems rather than a static CV:

- **Next.js 16 App Router / React 19 / TypeScript**, deployed via Docker.
- **Intent-routed retrieval**: each question is classified into an intent
  (site, background, projects, community, hobbies, music, contact, off-topic)
  and only the relevant curated profile data is put in the model's context.
  This is routing over curated files, not a vector store and not embeddings.
- **Four-tier provider fallback**: first a self-hosted model on Davit's own Mac
  at home (free to run, but a laptop sleeps and leaves the house), then OpenAI,
  then a smaller local Ollama model, then a regex classifier as a last resort —
  so the site keeps answering when any tier is unavailable.
- **Two independent circuit breakers**, one per guarded tier. Keeping them
  separate is the point: a machine that is away all week must not consume the
  paid provider's failure budget, and a struggling paid provider must not lock
  the site out of the free local one. Both trip only on transient failures and
  probe for recovery after a cooldown.
- **A reachability probe in front of the home tier**: an absent host silently
  drops packets rather than refusing the connection, so without it every request
  made while that machine was away would stall on TCP retries for ~20 seconds.
- **Token streaming over SSE**, with the request's real workflow trail streamed
  alongside the answer and rendered under it. While a cold model loads, the chat
  shows a live clock and says which tier is actually serving — including saying
  the Mac is asleep when it is.
- **Guardrails**: answers are grounded only in curated profile data, with
  IP-based rate limiting, a separate daily question quota, request validation,
  and structured request logging.
- **Published, not exposed**: how the site works is public; what it runs on is
  not. Credentials, network addresses, hostnames and file paths are never
  disclosed, and the public status endpoint reports tier names, model names and
  breaker states only.

---

## Music — Shepard D

Davit produces electronic music under the alias **Shepard D**.

Producing since 2008, Shepard D has spent over a decade exploring sound through different genres, collaborations, and creative phases. His music lives in the electronic world, defined by emotional melodies, atmospheric textures, and a signature love for piano themes. For Shepard D, music is a journal — every track is written to preserve a feeling, a moment, a state of mind. What you hear is always honest, always alive, and always rooted in what he feels right now.

### Genres & Style
- Electronic
- Ambient
- Melodic Electronic
- Piano-driven Electronic

### Selected Releases
- **Addictions** — Album, 2026 (latest release)
- **Repressed** — EP, 2025
- **Revelations** — Album, 2024
- **Hearts Reborn** — Album, 2024
- **Inner Hamster** — Album, 2024
- **Amber Sun** — Single, 2023
- **Purrifire** — Single, 2023
- **We** — Album, 2021

### Listen
- Spotify: https://open.spotify.com/artist/4G26tr9xqGvtZa9B0qboob
- Spotify-curated playlist: *Shepard D Radio*

---

## Contact

Location: Yerevan, Armenia

GitHub: https://github.com/davittatenkohayrapetyan
LinkedIn: https://www.linkedin.com/in/davit-hayrapetyan-04377561/
Website: https://davithayrapetyan.dev

Davit is open to conversations about staff/principal engineering, backend and
solution architecture, and AI-systems work. The fastest route is LinkedIn.
