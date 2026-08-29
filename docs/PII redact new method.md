# **🛡️ SYSTEM ARCHITECTURE & IMPLEMENTATION SPECIFICATION**

**Project Goal:** Implement a High-Performance, Hybrid Local Pseudonymization & PII Redaction Pipeline in Node.js/TypeScript using Hugging Face Token Classification (Isotonic/deberta-v3-base\_finetuned\_ai4privacy\_v2).  
**Target Platform / Runtime:** Node.js (TypeScript) \+ ONNX Runtime via @huggingface/transformers (or @xenova/transformers). Zero PyTorch or Python daemon dependencies required.

## **📐 ARCHITECTURAL OVERVIEW**

Plaintext  
                  \[Incoming Unstructured Text / Email / Prompt\]  
                                       │  
                                       ▼  
    ┌─────────────────────────────────────────────────────────────────────┐  
    │ STEP 1: Static Identity Registry (identity.yaml)                    │  
    │ \- Direct exact string matching for user names, emails, phones.      │  
    │ \- Latency: \< 1ms                                                    │  
    └─────────────────────────────────────────────────────────────────────┘  
                                       │  
                                       ▼  
    ┌─────────────────────────────────────────────────────────────────────┐  
    │ STEP 2: Structural Regex Engine (Layer 1 Patterns)                  │  
    │ \- Vehicle registration plates, Aadhaar, PAN, Credit Cards, Tickets. │  
    │ \- Latency: \< 1ms                                                    │  
    └─────────────────────────────────────────────────────────────────────┘  
                                       │  
                                       ▼  
    ┌─────────────────────────────────────────────────────────────────────┐  
    │ STEP 3: Hugging Face Token Classification (DeBERTa-v3)              │  
    │ \- Model: Isotonic/deberta-v3-base\_finetuned\_ai4privacy\_v2           │  
    │ \- Finds unknown/unstructured PII (Names, Addresses, Locations).     │  
    │ \- Latency: 10ms \- 30ms (CPU/ONNX)                                    │  
    └─────────────────────────────────────────────────────────────────────┘  
                                       │  
                                       ▼  
           \[Sanitized / Pseudonymized Payload Sent to Cloud LLM\]  
                                       │  
                                       ▼  
           \[Cloud LLM Returns Response / Tool Arguments\]  
                                       │  
                                       ▼  
    ┌─────────────────────────────────────────────────────────────────────┐  
    │ STEP 4: Local Rehydration / Unmasking Engine                        │  
    │ \- Restores tokens back to literal values for UI or Composio execution.│  
    │ \- Latency: \< 1ms                                                    │  
    └─────────────────────────────────────────────────────────────────────┘

## **🛠️ TASKS FOR THE CODING AGENT**

### **Task 1: Dependencies Installation & Configuration**

Install @huggingface/transformers (or @xenova/transformers) and js-yaml in the Node.js project.

Bash  
npm install @huggingface/transformers js-yaml  
npm install \--save-dev @types/js-yaml

### **Task 2: Create identity.yaml Configuration File**

Create identity.yaml at the project root directory. **Ensure this file is added to .gitignore.**

YAML  
\# identity.yaml — LOCAL ONLY (NEVER commit to Git or send to APIs)  
direct\_identifiers:  
  names:  
    \- "Nimit"  
    \- "Nimit Shah"  
    \- "Nimit Vasant Shah"  
    \- "Vasant Shah"  
    \- "nimitshah2503"  
  emails:  
    \- "nimit@example.com"  
  phones:  
    \- "+919876543210"  
  locations:  
    city: "Bangalore"  
    home\_address: "123 Main Street"

financial:  
  bank\_account\_numbers:  
    \- "090668361"

assets:  
  vehicles:  
    \- "KA51MS3156"  
  projects:  
    \- "Project Aurora"  
    \- "TrustClaw"

### **Task 3: Implement src/security/IdentityRegistry.ts**

Build a singleton class to load and parse identity.yaml.

TypeScript  
// src/security/IdentityRegistry.ts  
import fs from "fs";  
import path from "path";  
import yaml from "js-yaml";

export interface IdentityConfig {  
  direct\_identifiers: {  
    names: string\[\];  
    emails: string\[\];  
    phones: string\[\];  
    locations: Record\<string, string\>;  
  };  
  financial: {  
    bank\_account\_numbers: string\[\];  
  };  
  assets: {  
    vehicles: string\[\];  
    projects: string\[\];  
  };  
}

export class IdentityRegistry {  
  private static instance: IdentityRegistry;  
  private config: IdentityConfig | null \= null;

  private constructor() {  
    this.loadConfig();  
  }

  public static getInstance(): IdentityRegistry {  
    if (\!IdentityRegistry.instance) {  
      IdentityRegistry.instance \= new IdentityRegistry();  
    }  
    return IdentityRegistry.instance;  
  }

  private loadConfig() {  
    try {  
      const configPath \= path.resolve(process.cwd(), "identity.yaml");  
      if (fs.existsSync(configPath)) {  
        const fileContents \= fs.readFileSync(configPath, "utf8");  
        this.config \= yaml.load(fileContents) as IdentityConfig;  
      } else {  
        console.warn("\[IdentityRegistry\] identity.yaml not found. Falling back to empty rules.");  
      }  
    } catch (err) {  
      console.error("\[IdentityRegistry\] Error reading identity.yaml:", err);  
    }  
  }

  public getExactMatches(): { literal: string; category: string }\[\] {  
    if (\!this.config) return \[\];  
    const matches: { literal: string; category: string }\[\] \= \[\];

    const { direct\_identifiers, financial, assets } \= this.config;

    direct\_identifiers?.names?.forEach((n) \=\> matches.push({ literal: n, category: "NAME" }));  
    direct\_identifiers?.emails?.forEach((e) \=\> matches.push({ literal: e, category: "EMAIL" }));  
    direct\_identifiers?.phones?.forEach((p) \=\> matches.push({ literal: p, category: "PHONE" }));  
      
    if (direct\_identifiers?.locations) {  
      Object.values(direct\_identifiers.locations).forEach((loc) \=\>  
        matches.push({ literal: loc, category: "LOCATION" })  
      );  
    }

    financial?.bank\_account\_numbers?.forEach((b) \=\>  
      matches.push({ literal: b, category: "ACCOUNT" })  
    );

    assets?.vehicles?.forEach((v) \=\> matches.push({ literal: v, category: "VEHICLE" }));  
    assets?.projects?.forEach((proj) \=\> matches.push({ literal: proj, category: "PROJECT" }));

    // Sort by string length descending so longer phrases match before shorter tokens  
    return matches.sort((a, b) \=\> b.literal.length \- a.literal.length);  
  }  
}

### **Task 4: Implement src/security/PureShield.ts**

Combine Static Identity Matching, Layer 1 Structural Regexes, and DeBERTa Token Classification.

TypeScript  
// src/security/PureShield.ts  
import { pipeline, env } from "@huggingface/transformers";  
import { createHash } from "crypto";  
import { IdentityRegistry } from "./IdentityRegistry";

// Configure local ONNX cache directory  
env.allowRemoteModels \= true;  
env.localModelPath \= "./.models\_cache";

export class PureShield {  
  private static classifierInstance: any \= null;  
  private sessionTokenMap: Map\<string, string\> \= new Map(); // token \-\> rawValue  
  private sessionReverseMap: Map\<string, string\> \= new Map(); // rawValue \-\> token

  // Layer 1 Structural Patterns  
  private static LAYER1\_PATTERNS: Record\<string, RegExp\> \= {  
    INDIAN\_VEHICLE\_PLATE: /\\b\[A-Z\]{2}\\d{2}\[A-Z\]{1,2}\\d{4}\\b/gi,  
    INSURANCE\_CLAIM\_ID: /\\b\[A-Z\]{2}\\d{8,14}\\b/gi,  
    NUMERIC\_TICKET\_ID: /\\b\\d{7,10}\\b/g,  
    LEASE\_AGREEMENT\_HASH: /\\b\[A-Z\]{5}\[A-Z0-9\]{4}\\b/g,  
    EMAIL\_ADDRESS: /\\b\[A-Za-z0-9.\_%+-\]+@\[A-Za-z0-9.-\]+\\.\[A-Za-z\]{2,}\\b/g,  
    AADHAAR\_NUMBER: /\\b\\d{4}\\s?\\d{4}\\s?\\d{4}\\b/g,  
    PAN\_CARD: /\\b\[A-Z\]{5}\\d{4}\[A-Z\]{1}\\b/gi,  
  };

  private async getClassifier() {  
    if (\!PureShield.classifierInstance) {  
      // Load DeBERTa v3 AI4Privacy Token Classification model in ONNX format  
      PureShield.classifierInstance \= await pipeline(  
        "token-classification",  
        "Isotonic/deberta-v3-base\_finetuned\_ai4privacy\_v2",  
        { aggregation\_strategy: "simple" }  
      );  
    }  
    return PureShield.classifierInstance;  
  }

  private generateToken(rawValue: string, category: string): string {  
    const clean \= rawValue.trim();  
    if (this.sessionReverseMap.has(clean)) {  
      return this.sessionReverseMap.get(clean)\!;  
    }

    const hash \= createHash("md5").update(clean).digest("hex").slice(0, 4).toUpperCase();  
    const token \= \`\[CLAW\_${category.toUpperCase()}\_${hash}\]\`;

    this.sessionTokenMap.set(token, clean);  
    this.sessionReverseMap.set(clean, token);  
    return token;  
  }

  /\*\*  
   \* Complete Outbound Sanitization (Exact Match \-\> Regex \-\> DeBERTa Model)  
   \*/  
  public async redact(text: string): Promise\<string\> {  
    if (\!text || text.trim().length \=== 0) return text;  
    let sanitized \= text;

    // STEP 1: Static Identity Registry Matching  
    const exactMatches \= IdentityRegistry.getInstance().getExactMatches();  
    for (const { literal, category } of exactMatches) {  
      if (\!literal || literal.trim().length \=== 0) continue;  
      const escaped \= literal.replace(/\[-\\/\\\\^$\*+?.()|\[\\\]{}\]/g, "\\\\$&");  
      const regex \= new RegExp(\`\\\\b${escaped}\\\\b\`, "gi");

      sanitized \= sanitized.replace(regex, (match) \=\> {  
        return this.generateToken(match, category);  
      });  
    }

    // STEP 2: Layer 1 Structural Regex Matching  
    for (const \[category, regex\] of Object.entries(PureShield.LAYER1\_PATTERNS)) {  
      sanitized \= sanitized.replace(regex, (match) \=\> {  
        return this.generateToken(match, category);  
      });  
    }

    // STEP 3: Hugging Face DeBERTa Token Classification  
    try {  
      const classifier \= await this.getClassifier();  
      const entities \= await classifier(sanitized);

      if (entities && entities.length \> 0) {  
        // Sort entities backwards by character offset to safely splice strings  
        const sortedEntities \= entities.sort((a: any, b: any) \=\> b.start \- a.start);

        for (const entity of sortedEntities) {  
          if (entity.score \< 0.80) continue; // High-confidence threshold

          const rawSpan \= sanitized.slice(entity.start, entity.end);  
          // Skip if already tokenized  
          if (rawSpan.startsWith("\[CLAW\_")) continue;

          const category \= (entity.entity\_group || entity.entity || "PII").toUpperCase();  
          const token \= this.generateToken(rawSpan, category);

          sanitized \=  
            sanitized.slice(0, entity.start) \+  
            token \+  
            sanitized.slice(entity.end);  
        }  
      }  
    } catch (err) {  
      console.error("\[PureShield\] DeBERTa inference warning:", err);  
    }

    return sanitized;  
  }

  /\*\*  
   \* Local Rehydration (Swaps tokens back to literal values)  
   \*/  
  public unmask(text: string): string {  
    if (\!text) return text;  
    let restored \= text;

    for (const \[token, originalValue\] of this.sessionTokenMap.entries()) {  
      restored \= restored.replaceAll(token, originalValue);  
    }  
    return restored;  
  }  
}

### **Task 5: Integration Checkpoints**

#### **Gateway A: Intercept Outbound Prompts & Workbench Data**

In your AI SDK / OpenRouter dispatch function or multiLevelShield.ts:

TypeScript  
import { PureShield } from "./security/PureShield";

const shield \= new PureShield();

// Redact before sending to cloud LLM  
const sanitizedPrompt \= await shield.redact(rawUserPrompt);  
const sanitizedWorkbenchOutput \= await shield.redact(workbenchStdout);

// Deliver sanitizedPayload to Cloud API (DeepSeek / OpenRouter / Claude)

#### **Gateway B: Unmask Inbound UI & Composio Tool Invocations**

In your user-facing response handler or composioRouter.ts:

TypeScript  
// Unmask for local user UI rendering  
const userVisibleText \= shield.unmask(cloudModelResponse);

// Unmask tool arguments right before executing Composio action  
const realToolArguments \= JSON.parse(shield.unmask(JSON.stringify(rawToolArguments)));  
await composio.tools.execute(toolSlug, realToolArguments);

## **🧪 VERIFICATION CHECKLIST**

> 1. **Test Prompt:** "Hi, I am Nimit Shah. My vehicle KA51MS3156 was damaged under ticket 2828281."  
> 2. **Expected Outbound Output:** "Hi, I am \[CLAW\_NAME\_A1B2\]. My vehicle \[CLAW\_VEHICLE\_C3D4\] was damaged under ticket \[CLAW\_NUMERIC\_TICKET\_ID\_E5F6\]."  
> 3. **Expected UI / Tool Output:** Rehydrated completely back to "Nimit Shah", "KA51MS3156", and "2828281".  
> 4. **Latency Verification:** Benchmark execution time using console.time('redact'). Outbound pass must complete in **\< 35ms**.

**Execution Directive for Agent:** Proceed to generate or modify the target files as specified above. Ensure error handling and type safety are maintained across all modules.