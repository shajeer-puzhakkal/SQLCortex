# 🎨 UI / UX Improvement Instructions

**Target Models:** Gemini‑3, NanoBanana  
**Product:** SQLCortex (B2B SaaS – AI‑powered database optimization)  
**Page:** Projects / Organizations Landing Page  
**Audience:** Developers, Tech Leads, Small Teams

---

## 🎯 Goal
Improve clarity, onboarding flow, and action prioritization of the Projects / Organizations landing page **without changing the minimalist aesthetic**.

The page should clearly answer within **3 seconds**:
1. What is this product?
2. What should I do first?
3. What happens next?

---

## 🧭 High‑Level Design Direction
- Maintain a **clean, premium, minimalist** SaaS look (Notion / Linear / Stripe‑like)
- No heavy illustrations or marketing banners
- Improve **copy, hierarchy, spacing, and UI states**
- Prefer subtle UX improvements over visual noise

---

## 🔧 Design Issues & Required Improvements

### 1️⃣ Page Purpose Is Unclear
**Problem:**  
The page title “Projects” does not explain the page’s intent.

**Instruction:**  
Add a short, calm subtitle below the page title explaining what users should do.

**Suggested Copy:**
> *Create a project to connect a database and start optimizing queries with AI.*

---

### 2️⃣ Weak Primary Action Hierarchy
**Problem:**  
All call‑to‑action buttons appear equally important.

**Instruction:**  
Establish clear CTA hierarchy:
- **Primary CTA:** Create Project (solid / dark)
- **Secondary CTAs:** Create Org, Invite Members (outline / muted)

The user should be visually guided to create a project first.

---

### 3️⃣ Active Projects Section Feels Empty
**Problem:**  
Projects are the core object but lack context and engagement.

**Instruction:**  
Enhance project cards with:
- Clickable card behavior
- Metadata subtext (DB status, environment placeholder)
- Clear hover affordance

**Example Card Structure:**
```
Personal Project
PostgreSQL • Not connected
```

---

### 4️⃣ Invite Members Section Shown Too Early
**Problem:**  
Invite Members is visible even when no organization exists.

**Instruction:**  
Use conditional UI states:
- Disable the section until an org exists, OR
- Replace form with helper text

**Suggested Helper Copy:**
> *Create an organization to invite team members.*

Avoid showing unusable inputs.

---

### 5️⃣ Organizations Section Feels Passive
**Problem:**  
“No org memberships yet” feels like a dead end.

**Instruction:**  
Rewrite copy to encourage collaboration.

**Improved Copy Example:**
> *Create an organization to collaborate with your team and share projects.*

Visually emphasize **Create Org** as a meaningful next step.

---

### 6️⃣ Project Creation Form Can Be Smarter
**Problem:**  
Project type dropdown shows “Personal” even when no alternatives exist.

**Instruction:**  
- Hide or remove dropdown if only Personal projects exist
- Add helper text explaining what a project contains

**Suggested Helper Copy:**
> *Projects contain databases, queries, and AI analysis.*

---

### 7️⃣ Missing Onboarding Guidance
**Problem:**  
Users don’t know what happens after creating a project.

**Instruction:**  
Add a subtle “Next steps” guide near the bottom of the page.

**Example Layout:**
```
Next steps:
1. Create a project
2. Connect your database
3. Analyze and optimize queries with AI
```

Keep this visually light and non‑intrusive.

---

## 🎨 Visual Style Rules
- Neutral, warm background
- Generous whitespace
- Minimal shadows and effects
- No bright accent colors
- Typography and spacing should communicate hierarchy

---

## 🚫 What NOT To Do
- Do NOT redesign the entire layout
- Do NOT add marketing illustrations
- Do NOT introduce dashboards, charts, or metrics
- Do NOT overuse AI buzzwords

---

## ✅ Expected Output
- Improved layout suggestions
- Refined micro‑copy
- Better state handling
- Clear action hierarchy

The final result should feel:
> *Like a calm, obvious first step into a serious developer product.*

---

**Usage:** This document is intended to be given directly to Gemini‑3 or NanoBanana as a UI/UX improvement instruction set.

