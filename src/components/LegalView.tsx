import React from "react";
import { Link } from "./Link";

/**
 * Static legal documents for GameTrack, rendered from a plain data structure
 * so the prose stays readable and the layout stays in one place.
 *
 * These describe what the software actually does — data lives in a local
 * SQLite file, the browser only ever talks to its own origin, and the only
 * outbound calls are server-side Steam and IGDB lookups the user opts into.
 * Do not add claims here that the code does not back up.
 */

export type LegalSection = { heading: string; body: string[] };
export type LegalDoc = {
  slug: string;
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
};

const REPO = "https://github.com/weirdsmirk/GameTrack";
const UPDATED = "September 25, 2026";

export const LEGAL_DOCS: Record<string, LegalDoc> = {
  privacy: {
    slug: "legal/privacy",
    title: "Privacy Policy",
    updated: UPDATED,
    intro:
      "GameTrack is a self-hosted, local-first application. It has no account system, no analytics, and no third-party tracking. This policy explains what data it handles and where that data goes.",
    sections: [
      {
        heading: "The short version",
        body: [
          "Your game library is stored in a SQLite database on the machine running GameTrack. It is never uploaded anywhere. GameTrack has no telemetry, no advertising SDKs, and no analytics scripts. Nothing you log is sold, shared, or profiled.",
        ],
      },
      {
        heading: "Data stored on your machine",
        body: [
          "GameTrack writes the following to a local SQLite database in its data directory: the titles in your library, each title's status, playtime, rating, completion date, notes, genres, and platform tags; any Steam profile you choose to connect; your wishlist; your playtime sessions; and any custom platforms or display preferences you create.",
          "Authentication values you supply — a Steam Web API key, and Twitch/IGDB client credentials — are stored locally in a .env file or your environment configuration. They are read by the server process on your own machine and are never transmitted to us.",
          "Interface preferences such as your chosen theme and the last tab you viewed are kept in your browser's localStorage. These never leave your browser.",
        ],
      },
      {
        heading: "Data that leaves your machine",
        body: [
          "GameTrack's browser interface only ever connects to its own origin. All third-party requests are made by the server running on your machine, and only when you have configured the relevant integration:",
          "Steam — if you connect a Steam profile, the server calls Valve's Steam Web API to retrieve your owned games and store details. Your Steam API key and SteamID are sent to Valve, not to us.",
          "IGDB / Twitch — if you configure IGDB credentials, the server calls Twitch's OAuth service and IGDB's API to retrieve game metadata for search and discovery.",
          "Your browser loads poster artwork and web fonts directly from IGDB, Unsplash, Steam's CDN, and Google Fonts when you view those images or text. Those requests disclose your IP address and browser user-agent to those providers under their own privacy policies.",
        ],
      },
      {
        heading: "What GameTrack never does",
        body: [
          "GameTrack does not collect analytics or telemetry, does not set tracking cookies, does not run advertising or third-party tracking scripts, does not operate a server-side account or user database, and does not transmit your library to us or to any third party.",
        ],
      },
      {
        heading: "Deleting your data",
        body: [
          "Because your data is local, you control it completely. You can delete individual entries from within the app, export your library at any time, or remove the entire database file to erase everything. Uninstalling the application and deleting its data directory removes all of it.",
        ],
      },
      {
        heading: "Children",
        body: [
          "GameTrack is a personal library organiser and is not directed at children under 13. It does not knowingly collect personal information from anyone, of any age.",
        ],
      },
      {
        heading: "Changes and contact",
        body: [
          "If this policy changes, the updated date at the top of this page will change with it. For any privacy question, open an issue on the public repository.",
        ],
      },
    ],
  },

  terms: {
    slug: "legal/terms",
    title: "Terms of Service",
    updated: UPDATED,
    intro:
      "These terms cover your use of the GameTrack software. By using it you agree to them. If you do not agree, do not use the software.",
    sections: [
      {
        heading: "Licence to use",
        body: [
          "GameTrack is open-source software released under the MIT Licence. You may use, study, modify and redistribute it in accordance with that licence. These terms add obligations to that licence; where the two conflict, the MIT Licence governs your use of the source code itself.",
        ],
      },
      {
        heading: "Acceptable use",
        body: [
          "Do not use GameTrack to break the law, to infringe the rights of others, to attack or overload the software or the machine hosting it, or to distribute a modified version in a way that misrepresents its origin.",
          "Do not remove or alter copyright, licence, or attribution notices from the source code or from copies you distribute.",
        ],
      },
      {
        heading: "Your content",
        body: [
          "You retain all rights to the game titles, notes, ratings, and other content you enter into GameTrack. GameTrack claims no ownership over it. Because your data is stored locally, we never receive or hold your content.",
          "Game metadata, artwork, critic scores, and store information retrieved from Steam, IGDB, and related services remain the property of their respective owners and are subject to those services' own terms. GameTrack presents them for personal, non-commercial use and does not grant you any rights in them.",
        ],
      },
      {
        heading: "Intellectual property",
        body: [
          "GameTrack and its source code are copyright works. All rights not expressly granted are reserved. See the Licence and Copyright page for details on the code licence and the trademark position on the GameTrack name and logo.",
          "The GameTrack name, wordmark, and logo are trademarks. You may use them to refer truthfully to the original project. You may not use them in a way that suggests sponsorship, endorsement, or official affiliation with a product, service, or fork that is not the original.",
        ],
      },
      {
        heading: "No warranty",
        body: [
          "GameTrack is provided \"as is\", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. The authors and copyright holders are not liable for any damages arising from the use or inability to use the software.",
        ],
      },
      {
        heading: "Limitation of liability",
        body: [
          "To the fullest extent permitted by applicable law, in no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or its use.",
        ],
      },
      {
        heading: "Third-party services",
        body: [
          "GameTrack can connect to Steam, Twitch, and IGDB. Those services are operated by third parties under their own terms and privacy policies. GameTrack does not control them and is not responsible for their availability, content, or conduct.",
        ],
      },
    ],
  },

  license: {
    slug: "legal/license",
    title: "Licence & Copyright",
    updated: UPDATED,
    intro:
      "GameTrack is free, open-source software. This page states the licence the code is released under and the separate position on the GameTrack name and logo.",
    sections: [
      {
        heading: "Code licence — MIT",
        body: [
          "Copyright (c) 2026 GameTrack. All rights reserved.",
          "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
          "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
          "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
        ],
      },
      {
        heading: "Attribution is the condition that matters",
        body: [
          "The MIT Licence lets anyone reuse, modify, and even sell the code. The one thing it requires is that the copyright notice and licence text travel with every copy or substantial portion. If you fork GameTrack or ship a modified build, you must keep that notice intact.",
          "Removing the notice is the one action the licence actually prohibits, and doing so is a licence violation as well as copyright infringement.",
        ],
      },
      {
        heading: "Trademarks",
        body: [
          "The GameTrack name, the GAMETRACK wordmark, and the logo are trademarks rather than part of the MIT Licence grant. The licence covers the code, not the branding.",
          "You may use the name and logo to refer truthfully to GameTrack, to link to this project, or to state that your work is based on it. You may not use them in a way that implies sponsorship, endorsement, or official affiliation, or in a way that confuses users about which product they are using.",
        ],
      },
      {
        heading: "Contributing",
        body: [
          "Contributions are welcome through the public repository. By submitting a pull request you agree that your contribution is licensed under the same MIT Licence.",
        ],
      },
    ],
  },

  dmca: {
    slug: "legal/dmca",
    title: "DMCA & Takedown",
    updated: UPDATED,
    intro:
      "If you believe GameTrack's code, name, or artwork has been copied or misused, here is how to report it and what happens next.",
    sections: [
      {
        heading: "Reporting infringement",
        body: [
          "Open a report through the public issue tracker. Because this project is self-hosted and distributed through a public repository, the fastest and most reliable route is an issue on that repository — it creates a public, timestamped record.",
          "Please include: the URL or location of the infringing material, what exactly is being copied, how it relates to GameTrack, and your contact details so a response can be sent.",
        ],
      },
      {
        heading: "What a valid notice should contain",
        body: [
          "A copyright notice should identify the work claimed to have been infringed, identify the material that infringes it, provide contact details for the sender, state that the sender has a good-faith belief the use is not authorised by the copyright owner, and state that the information is accurate and that the sender is authorised to act on the owner's behalf.",
          "Incomplete notices cannot be acted on, because there is no way to verify a claim that does not identify the work or the infringement.",
        ],
      },
      {
        heading: "How reports are handled",
        body: [
          "Reports are reviewed and, where infringement is established, handled by removing the infringing material, issuing a takedown to the host, and where appropriate contacting the responsible party. Determinations are made on the facts provided, so accurate and complete reports move fastest.",
        ],
      },
      {
        heading: "Counter-notices",
        body: [
          "If you believe material was removed by mistake, you may submit a counter-notice through the same channel. It must identify the material removed, where it appeared before removal, and your contact details, and must include a statement under penalty of perjury that the removal was a mistake or misidentification.",
        ],
      },
      {
        heading: "Repeat infringement",
        body: [
          "In clear cases of repeat infringement, access to the project may be withdrawn.",
        ],
      },
    ],
  },
};

/**
 * Routes are namespaced under /legal/ rather than sitting at the root
 * (/legal/license, not /license). At the root, /license collided with the
 * repository's own LICENSE file — the dev server serves the project root, and
 * on a case-insensitive filesystem the request resolved to that file and
 * returned raw licence text instead of ever reaching the SPA.
 */
export const LEGAL_ORDER: LegalDoc[] = [
  LEGAL_DOCS.privacy!,
  LEGAL_DOCS.terms!,
  LEGAL_DOCS.license!,
  LEGAL_DOCS.dmca!,
];

// Indexed by slug (the route) rather than by the object key, so the lookup
// below cannot drift out of step with the slugs above.
const BY_SLUG: Record<string, LegalDoc> = Object.fromEntries(
  LEGAL_ORDER.map((doc) => [doc.slug, doc]),
);

const slugFromPath = (pathname: string): string =>
  pathname.replace(/^\//, "").replace(/\/+$/, "");

export const getLegalDoc = (pathname: string): LegalDoc | null =>
  BY_SLUG[slugFromPath(pathname)] ?? null;

export const LegalView: React.FC<{ doc: LegalDoc }> = ({ doc }) => (
  <div className="min-h-dvh bg-brand-bg text-zinc-300 font-sans selection:bg-brand-accent/30 selection:text-brand-accent">
    <div className="mx-auto w-full max-w-3xl px-6 md:px-12 py-14 md:py-20">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <span className="text-lg font-black tracking-tighter leading-none">
          <span className="text-white">GAME</span>
          <span className="text-brand-accent">TRACK</span>
          <span className="text-brand-accent">_</span>
        </span>
        <Link to="/" className="font-mono text-[11px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-accent transition-colors">
          &larr; Back to registry
        </Link>
      </div>

      <h1 className="mt-12 text-4xl sm:text-5xl font-black uppercase tracking-tighter leading-[0.95] text-white">
        {doc.title}
      </h1>
      <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-brand-muted">
        Last updated {doc.updated}
      </p>

      <p className="mt-8 text-base leading-relaxed text-zinc-300">{doc.intro}</p>

      {doc.sections.map((section) => (
        <section key={section.heading} className="mt-10">
          <h2 className="text-xl font-black uppercase tracking-tight text-white">{section.heading}</h2>
          {section.body.map((para) => (
            <p key={para.slice(0, 40)} className="mt-4 text-sm leading-relaxed text-zinc-400">
              {para}
            </p>
          ))}
        </section>
      ))}

      <div className="mt-16 border-t border-brand-border pt-6">
        <p className="font-mono text-[11px] uppercase tracking-widest text-brand-muted">
          Project source and reports:{" "}
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-accent hover:underline underline-offset-4"
          >
            github.com/weirdsmirk/GameTrack
          </a>
        </p>
      </div>
    </div>
  </div>
);
