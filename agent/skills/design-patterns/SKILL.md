---
name: design-patterns
role: Software Architect / Design Pattern Specialist
description: >
  Reference guide to the 23 classic Gang-of-Four software design patterns (Creational,
  Structural, Behavioral), complete with directives and "when to use" criteria. Load whenever
  selecting appropriate architectural patterns, evaluating trade-offs, refactoring complex code,
  or explaining specific design patterns.
triggers: [pattern, "design pattern", "gang of four", gof, singleton, factory, observer, strategy, decorator, adapter, facade]
version: 1.0
requires_tools: [read_tool, grep_tool]
composes_with: [programmer, solid-principles, code-reviewer, architect]
---

# Design Patterns

A quick-reference guide to the classic (Gang of Four) design patterns, grouped by category, each with a directive and clear criteria for when it applies.

## How to use this skill

1. If the user names a specific pattern, jump to that pattern's entry below and explain the directive + when-to-use criteria in the context of their code/problem.
2. If the user describes a problem ("I have multiple ways to calculate shipping cost and want to swap between them"), use the **Quick Decision Guide** table to match the problem shape to a pattern, then explain why it fits.
3. If the user wants a broad overview, walk through the three categories (Creational, Structural, Behavioral) and summarize each pattern's directive in one line.
4. Always pair a suggested pattern with a caveat if a simpler solution would work — see **General Directives** at the end.

---

## Creational Patterns
*Concerned with object creation mechanisms.*

### Singleton
**Directive:** Ensure a class has only one instance, with a global access point.
**Use when:**
- Exactly one object is needed to coordinate actions (e.g. config manager, logger, connection pool).
- You need controlled access to a shared resource.
**Avoid when:** It introduces hidden global state or makes unit testing hard — prefer dependency injection instead.

### Factory Method
**Directive:** Define an interface for creating an object, but let subclasses decide which class to instantiate.
**Use when:**
- A class can't anticipate the exact type of objects it must create.
- You want to delegate instantiation logic to subclasses.

### Abstract Factory
**Directive:** Provide an interface for creating families of related objects without specifying concrete classes.
**Use when:**
- Your system needs to work with multiple families of related products (e.g. UI themes: Windows vs Mac widgets).
- You want to enforce that related objects are used together.

### Builder
**Directive:** Separate the construction of a complex object from its representation.
**Use when:**
- An object has many optional parameters or construction steps (avoids telescoping constructors).
- You want the same construction process to create different representations.

### Prototype
**Directive:** Create new objects by copying an existing instance (a "prototype").
**Use when:**
- Object creation is expensive and cloning is cheaper.
- You need to avoid subclassing just to create variations of objects.

---

## Structural Patterns
*Concerned with how classes/objects are composed.*

### Adapter
**Directive:** Convert the interface of a class into another interface clients expect.
**Use when:**
- You need to use an existing class but its interface doesn't match what you need.
- Integrating third-party or legacy code without modifying it.

### Bridge
**Directive:** Decouple an abstraction from its implementation so both can vary independently.
**Use when:**
- You want to avoid a permanent binding between abstraction and implementation.
- Both the abstraction and implementation should be independently extensible.

### Composite
**Directive:** Compose objects into tree structures to represent part-whole hierarchies.
**Use when:**
- Clients should treat individual objects and compositions uniformly (e.g. file systems, UI component trees).

### Decorator
**Directive:** Attach additional responsibilities to an object dynamically.
**Use when:**
- You need to add behavior/state to individual objects without affecting others of the same class.
- Subclassing would produce an explosion of classes.

### Facade
**Directive:** Provide a unified, simplified interface to a set of interfaces in a subsystem.
**Use when:**
- A subsystem is complex and you want to give clients a simple entry point.
- You want to decouple client code from subsystem internals.

### Flyweight
**Directive:** Use sharing to support large numbers of fine-grained objects efficiently.
**Use when:**
- Memory usage is a concern due to a huge number of similar objects.
- Object state can be split into intrinsic (shared) and extrinsic (contextual) parts.

### Proxy
**Directive:** Provide a surrogate/placeholder to control access to another object.
**Use when:**
- You need lazy loading, access control, logging, or caching around an object (e.g. virtual proxy, protection proxy).

---

## Behavioral Patterns
*Concerned with object interaction and responsibility distribution.*

### Chain of Responsibility
**Directive:** Pass a request along a chain of handlers until one handles it.
**Use when:**
- More than one object may handle a request, and the handler isn't known in advance (e.g. middleware pipelines).

### Command
**Directive:** Encapsulate a request as an object, allowing parameterization and queuing.
**Use when:**
- You need undo/redo, task queues, or to decouple sender from receiver of a request.

### Interpreter
**Directive:** Define a grammar and interpreter for a language.
**Use when:**
- You need to interpret sentences in a simple, well-defined language (e.g. rule engines, DSLs).

### Iterator
**Directive:** Provide a way to access elements of a collection sequentially without exposing its structure.
**Use when:**
- You need uniform traversal across different collection types.

### Mediator
**Directive:** Define an object that encapsulates how a set of objects interact.
**Use when:**
- Objects communicate in complex, many-to-many ways — centralize the logic to reduce coupling (e.g. chat rooms, form field coordination).

### Memento
**Directive:** Capture and externalize an object's internal state without violating encapsulation, so it can be restored later.
**Use when:**
- You need undo functionality or state checkpoints/rollback.

### Observer
**Directive:** Define a one-to-many dependency so that when one object changes state, all dependents are notified.
**Use when:**
- Changes to one object require updating others, and you don't want tight coupling (e.g. event systems, pub/sub, MVC views).

### State
**Directive:** Allow an object to alter its behavior when its internal state changes.
**Use when:**
- An object's behavior depends on its state, and it has many conditional branches based on that state.

### Strategy
**Directive:** Define a family of interchangeable algorithms and make them interchangeable at runtime.
**Use when:**
- You have multiple ways to perform a task (e.g. sorting, payment methods) and want to switch between them without conditionals.

### Template Method
**Directive:** Define the skeleton of an algorithm in a method, deferring some steps to subclasses.
**Use when:**
- Multiple classes share the same algorithm structure but differ in specific steps.

### Visitor
**Directive:** Represent an operation to be performed on elements of an object structure, without changing their classes.
**Use when:**
- You need to add new operations to a stable class hierarchy without modifying the classes themselves.

---

## Quick Decision Guide

| Problem | Pattern |
|---|---|
| Need exactly one instance | Singleton |
| Complex object construction | Builder |
| Incompatible interfaces | Adapter |
| Add behavior without subclassing | Decorator |
| Simplify a complex subsystem | Facade |
| Notify multiple objects of changes | Observer |
| Swap algorithms at runtime | Strategy |
| Undo/redo functionality | Command / Memento |
| Traverse a collection | Iterator |
| Behavior changes with state | State |

---

## General Directives
- Favor **composition over inheritance** where a pattern offers both options (Decorator, Strategy, Bridge).
- Don't force a pattern where simple code suffices — patterns solve *specific* recurring problems, not every problem.
- Recognize patterns from the *problem shape* first, then pick the pattern — not the reverse.
- Combine patterns when appropriate (e.g. Composite + Visitor, Factory + Singleton).
