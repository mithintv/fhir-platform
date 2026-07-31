# FHIR
FHIR (Fast Healthcare Interoperability Resources) is a modern healthcare data standard created by HL7 that defines how
clinical data is structured, stored, and exchanged across systems using web-native concepts. It represents healthcare
information as small, composable resources (e.g., Patient, Condition, Observation, Procedure) with consistent schemas,
standardized medical codes (ICD, CPT, LOINC, SNOMED), and explicit timestamps and references between records. FHIR is
designed to work over REST APIs and bulk data exports, making it practical for real-world EHR pipelines while preserving
clinical nuance like longitudinal history, uncertainty, and missing data. In practice, FHIR is what turns messy hospital
databases into interoperable, machine-readable patient timelines.

## Context
In this assessment, you will work with FHIR bulk data, which closely mirrors real EHR data while remaining privacy-safe. You
are building a clinician-facing prior authorization review tool that ingests raw FHIR resources, presents a clear patient view,
and uses AI-assisted reasoning to determine whether a procedure is likely to meet coverage requirements.

## Data
[Link to download the data](https://github.com/smart-on-fhir/sample-bulk-fhir-datasets/archive/refs/heads/1000-patients.zip)

### Part A: Data Ingestion
Parse raw FHIR bulk data into a usable internal model and deliberately optimize one performance bottleneck.

##### Requirements
- Parse and normalize FHIR resources
- Correctly resolve references (e.g., Condition.subject → Patient)
- Group all resources by patient
- Safely handle missing or partial fields

#### Performance Requirement (Mandatory)
You must:
1. Choose one performance optimization technique
2. Measure performance before and after
3. Explain your choice

We care less about the absolute speedup and more about whether you optimized the right thing first.

### Part B: Frontend
Build a React (or Next.js) UI that includes:

Patient Selector
- Select a patient by name or ID
- Switching patients updates all views

Clinical Snapshot
- Age, sex
- Active conditions
- Recent procedures
- Key observations (e.g., BMI, blood pressure)

Timeline View
- Chronologically ordered list of:
  - Observations
  - Procedures
- Each entry shows:
  - Display name
  - Date
  - Source FHIR resource ID

UX Expectations
- Information hierarchy > visual polish
- Missing data must be explicit

### Part C: Eligibility Logic & Cohort Report
Implement deterministic eligibility logic using the following simplified bariatric surgery policy.

Eligibility Criteria (Per Patient)
- BMI ≥ 40 OR
- BMI ≥ 35 AND at least one comorbidity (e.g., hypertension, type 2 diabetes)

Required Documentation
- Evidence of prior weight-loss attempts
- Psychological evaluation

Each patient must be classified as exactly one of:
- eligible
- not eligible
- unknown (insufficient or missing data)

You must clearly explain why a patient is classified as unknown (e.g., missing BMI observation, missing comorbidity evidence,
missing documentation).

Cohort-Level Requirement
In addition to per-patient logic, you must generate a cohort eligibility report across all patients in the dataset.
The report must include:
- Total number of patients
- Count and percentage of patients in each category:
  - eligible
  - not eligible
  - unknown
- Breakdown of top reasons for unknown status
(e.g., missing BMI, no recent observations, missing documentation)

#### Part D: AI-Assisted Review
Add an AI Assist capability that helps reviewers understand why a patient (or cohort) is eligible, not eligible, or unknown —
without asserting false certainty.
This feature must operate on top of the deterministic logic from Part C and must not override it.

Core Requirement
When triggered for a single patient, the AI Assist must return a fully structured, grounded JSON output:
```json
{
  "clinicalSummary": "52-year-old female with long-standing morbid obesity and hypertension.",
  "eligibilityAssessment": "unknown",
  "checklist": [
    {
      "requirement": "BMI threshold",
      "status": "met",
      "evidence": ["Observation/observation-123"]
    },
    {
      "requirement": "Comorbidity present",
      "status": "met",
      "evidence": ["Condition/condition-456"]
    },
    {
      "requirement": "Psychological evaluation",
      "status": "unknown",
      "evidence": []
    }
  ],
  "recommendedNextSteps": [
    "Request documentation of psychological evaluation"
  ]
}
```
Hard Constraints (Non-Negotiable)
1. Grounding
  - Every factual claim must:
    - Reference one or more FHIR resource IDs, or
    - Be explicitly marked as unknown
  - Free-text medical claims without evidence are not acceptable
2. Determinism Boundary
  - Eligibility status must come from Part C logic
  - The AI may explain or contextualize, but not change outcomes
3. Failure Handling
  - You must explicitly handle:
    - Model failure
    - Empty or partial responses
    - Conflicting evidence
  - The system must degrade safely (e.g., fall back to deterministic outputs)
4. No Silent Inference
  - If data is missing, the model must say so
  - “Likely”, “probably”, or “implied” without evidence is disallowed
