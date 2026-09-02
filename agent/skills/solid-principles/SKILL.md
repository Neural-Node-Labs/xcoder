---
name: solid-principles
role: Software Architect / OOP Design Specialist
description: >
  Reference guide to the five SOLID object-oriented design principles (Single Responsibility,
  Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion), complete with
  directives, violation signs, and fix patterns. Load whenever reviewing class or module design,
  refactoring coupled code, or evaluating adherence to clean OOP design principles.
triggers: [solid, "solid principles", "single responsibility", "open closed", "liskov substitution", "interface segregation", "dependency inversion", decouple, refactor, "oop design"]
version: 1.0
requires_tools: [read_tool, grep_tool]
composes_with: [programmer, code-reviewer, architect, rca]
---

# SOLID Principles

A quick-reference guide to the five SOLID principles, each with a directive, signs of violation, and how to fix it.

## How to use this skill

1. If the user names a specific principle, explain the directive and apply it to their code/problem.
2. If the user pastes code and asks for a review, scan it against the **violation signs** for each principle and flag the ones that apply.
3. If the user describes a design problem, use the **Quick Decision Guide** to match the symptom to the principle that addresses it.
4. Don't force all five onto every review — flag what's genuinely relevant, and note tradeoffs (see **General Directives**).

---

## S — Single Responsibility Principle
**Directive:** A class/module should have only one reason to change.
**Violation signs:**
- A class does unrelated things (e.g. a `User` class that also handles email sending and database persistence).
- Changing one feature risks breaking unrelated functionality.
- The class name is vague or joined with "and" (`ReportGeneratorAndEmailer`).
**Fix:** Split responsibilities into separate classes, each owning one concern; compose them where needed.

---

## O — Open/Closed Principle
**Directive:** Classes should be open for extension, but closed for modification.
**Violation signs:**
- Adding a new case means editing an existing class's internals (e.g. a growing `if/elif` or `switch` chain on type).
- Every new feature touches the same core file, risking regressions in unrelated cases.
**Fix:** Extract the varying behavior behind an interface/abstract class, and add new behavior via new subclasses or implementations instead of editing existing code (Strategy or Factory patterns often apply here).

---

## L — Liskov Substitution Principle
**Directive:** Subtypes must be substitutable for their base types without breaking correctness.
**Violation signs:**
- A subclass overrides a method to throw an exception, do nothing, or narrow what the base type promised.
- Client code checks the concrete type before calling a method (`if isinstance(x, SubclassY)`).
- Classic example: `Square extends Rectangle` breaks if `setWidth`/`setHeight` are independent in the base class.
**Fix:** Make sure a subclass honors the base class's contract (preconditions no stronger, postconditions no weaker). If it can't, it shouldn't be a subclass — reach for composition or a shared interface instead.

---

## I — Interface Segregation Principle
**Directive:** Clients shouldn't be forced to depend on methods they don't use.
**Violation signs:**
- A large "fat" interface where implementers must stub out irrelevant methods (`throw new NotImplementedException()`).
- Changing one method's signature forces recompiling/retesting classes that never use it.
**Fix:** Split large interfaces into smaller, role-specific ones; classes implement only the interfaces relevant to them.

---

## D — Dependency Inversion Principle
**Directive:** Depend on abstractions, not concrete implementations. High-level modules shouldn't depend on low-level modules — both should depend on abstractions.
**Violation signs:**
- A high-level class directly instantiates a low-level class (`new MySqlDatabase()` inside business logic).
- Swapping an implementation (e.g. database, payment provider) requires editing high-level code.
- Hard to unit test because dependencies can't be mocked.
**Fix:** Introduce an interface/abstract class between layers; inject the concrete implementation from outside (constructor/dependency injection) rather than instantiating it inline.

---

## Quick Decision Guide

| Symptom | Principle Violated |
|---|---|
| Class does too many unrelated things | Single Responsibility |
| Adding a feature means editing existing code everywhere | Open/Closed |
| Subclass breaks behavior the base class promised | Liskov Substitution |
| Class forced to implement methods it doesn't need | Interface Segregation |
| Business logic tightly coupled to a concrete implementation | Dependency Inversion |
| Hard to unit test due to hardcoded dependencies | Dependency Inversion |
| Growing if/else or switch on type | Open/Closed |

---

## General Directives
- SOLID principles are guidelines, not laws — over-applying them (e.g. an interface for every single class) can add needless indirection. Weigh the cost of abstraction against the actual likelihood of change.
- SRP and ISP both fight bloat — SRP at the class level, ISP at the interface level.
- OCP and DIP work together: depending on abstractions (DIP) is usually what *lets* you extend without modifying (OCP).
- When reviewing code, prioritize violations that cause real pain (hard to test, hard to extend, fragile on change) over theoretical purity.
