package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * calls.ndjson: every call site inside a dumped type's body, with the receiver's static type and the declaration it
 * resolves to. A target is only written when the declaration is in this checkout; a library call is named as such,
 * never guessed. Anonymous and local class bodies are inside their enclosing method's span, so their calls belong to it.
 */
public final class Sites {

    private Sites() {
    }

    /** Subtypes of every declared type, and each type's methods by name and arity: a call to an interface lists them. */
    private record Index(java.util.Set<String> declared, java.util.Map<String, java.util.Set<String>> subtypes,
                         java.util.Map<String, java.util.Set<String>> supertypes,
            java.util.Map<String, java.util.Map<String, String>> methods,
            java.util.Map<String, java.util.Map<String, String>> generated,
            java.util.Map<String, String> generatedFields,
            java.util.Map<String, java.util.Map<String, String>> arity) {
    }

    private static Index index(List<CtType<?>> types, java.util.Map<String, List<Lombok.Item>> synth) {
        java.util.Set<String> declared = new java.util.HashSet<>();
        java.util.Map<String, java.util.Map<String, String>> methods = new java.util.HashMap<>();
        java.util.Map<String, java.util.Map<String, String>> arity = new java.util.HashMap<>();
        for (CtType<?> t : types) {
            declared.add(Names.qualified(t));
            java.util.Map<String, String> byShape = new java.util.HashMap<>();
            java.util.Map<String, String> byArity = new java.util.HashMap<>();
            java.util.Set<String> ambiguous = new java.util.HashSet<>();
            for (CtExecutable<?> e : executables(t)) {
                if (syntheticEnum(t, e.getSimpleName())) continue;
                String id = Names.methodId(t, e instanceof spoon.reflect.declaration.CtConstructor<?>
                        ? t.getSimpleName() : e.getSimpleName(), paramTypes(e));
                byShape.putIfAbsent(e.getSimpleName() + "/" + e.getParameters().size(), id);
                // Name and arity, unique only: two members with the same shape are not a fact.
                int n = e.getParameters().size();
                String shape = e.getSimpleName() + "/" + n;
                if (byArity.containsKey(shape)) ambiguous.add(shape);
                else byArity.put(shape, id);
                if (n > 0 && e.getParameters().get(n - 1).isVarArgs()) {
                  String varargsShape = e.getSimpleName() + "/" + (n - 1);
                  if (!byArity.containsKey(varargsShape)) byArity.put(varargsShape, id);
                }
            }
            for (String shape : ambiguous) byArity.remove(shape);
            if (t instanceof spoon.reflect.declaration.CtRecord record)
                for (var component : record.getRecordComponents())
                    byShape.put(component.getSimpleName() + "/0",
                            Names.methodId(t, component.getSimpleName(), List.of()));
            methods.put(Names.qualified(t), byShape);
            arity.put(Names.qualified(t), byArity);
        }
        java.util.Map<String, java.util.Set<String>> subtypes = new java.util.HashMap<>();
        for (CtType<?> t : types) {
            String fqn = Names.qualified(t);
            java.util.Set<String> seen = new java.util.HashSet<>();
            java.util.ArrayDeque<CtType<?>> queue = new java.util.ArrayDeque<>();
            queue.add(t);
            while (!queue.isEmpty()) {
                CtType<?> current = queue.poll();
                List<spoon.reflect.reference.CtTypeReference<?>> supers = new ArrayList<>(current.getSuperInterfaces());
                if (current instanceof spoon.reflect.declaration.CtClass<?> c && c.getSuperclass() != null)
                    supers.add(c.getSuperclass());
                for (var s : supers) {
                    String superFqn = Names.qualified(s);
                    if (!declared.contains(superFqn) || !seen.add(superFqn)) continue;
                    subtypes.computeIfAbsent(superFqn, k -> new java.util.TreeSet<>()).add(fqn);
                    CtType<?> declaration = s.getTypeDeclaration();
                    if (declaration != null) queue.add(declaration);
                }
            }
        }
        java.util.Map<String, java.util.Map<String, String>> generated = new java.util.HashMap<>();
        java.util.Map<String, String> generatedFields = new java.util.HashMap<>();
        for (var e : synth.entrySet())
            for (Lombok.Item item : e.getValue()) {
                if ("method".equals(item.kind()))
                    generated.computeIfAbsent(item.owner(), k -> new java.util.HashMap<>())
                            .putIfAbsent(item.name() + "/" + item.params().size(), item.id());
                else if ("field".equals(item.kind()))
                    generatedFields.put(item.owner() + "#" + item.name(), item.type() == null ? "" : item.type());
            }
        // The other direction: which declared types a type inherits from, for a call written without a receiver.
        java.util.Map<String, java.util.Set<String>> supertypes = new java.util.HashMap<>();
        for (CtType<?> t : types) {
            java.util.Set<String> supers = new java.util.TreeSet<>();
            List<spoon.reflect.reference.CtTypeReference<?>> written = new ArrayList<>(t.getSuperInterfaces());
            if (t instanceof spoon.reflect.declaration.CtClass<?> c && c.getSuperclass() != null)
                written.add(c.getSuperclass());
            for (var superRef : written) {
                String superFqn = Names.qualified(superRef);
                if (declared.contains(superFqn)) supers.add(superFqn);
            }
            supertypes.put(Names.qualified(t), supers);
        }
        return new Index(declared, subtypes, supertypes, methods, generated, generatedFields, arity);
    }

    public static void write(List<CtType<?>> types, java.util.Map<String, List<Lombok.Item>> synth, Path root,
            Path out) throws IOException {
        Index index = index(types, synth);
        try (Ndjson w = new Ndjson(out)) {
            for (CtType<?> type : types) {
                for (CtExecutable<?> executable : executables(type))
                    writeCalls(w, type, executable, methodIdOf(type, executable), index, root);
                // A method of an anonymous class is body work of the member that writes it, filed under the type.
                for (spoon.reflect.declaration.CtTypeMember member : type.getTypeMembers())
                    if (member instanceof CtExecutable<?> body)
                        for (CtMethod<?> inner : Anonymous.methods(body))
                            writeCalls(w, type, inner, Anonymous.id(type, inner, root), index, root);
            }
        }
    }

    /** `values()`/`valueOf(String)` on an enum are compiler-written: never a member, never a target. */
    private static boolean syntheticEnum(CtType<?> owner, String name) {
        return owner.isEnum() && ("values".equals(name) || "valueOf".equals(name));
    }

    private static List<CtExecutable<?>> executables(CtType<?> type) {
        List<CtExecutable<?>> out = new ArrayList<>();
        for (var member : type.getTypeMembers())
            if (member instanceof spoon.reflect.declaration.CtConstructor<?> ctor) out.add(ctor);
            else if (member instanceof CtMethod<?> method) out.add(method);
        return out;
    }

    private static void row(JsonGenerator g, CtType<?> type, CtExecutable<?> owner, String methodId,
            CtInvocation<?> call, Positions.Pos pos, Index index, Path root) throws IOException {
        CtExecutableReference<?> ref = call.getExecutable();
        String name = ref == null ? "?" : ref.getSimpleName();
        int argc = call.getArguments().size();
        String targetText = safeText(call.getTarget());
        // Lombok's `log` is a field nobody declared: the target is a bare name, and the synthesis knows its type.
        String fieldType = targetText != null && targetText.matches("[A-Za-z_$][\\w$]*")
                ? index.generatedFields().get(Names.qualified(type) + "#" + targetText) : null;
        // The receiver, chains included: a library call's return type is the only way to type what follows it.
        String receiverName = call.getTarget() == null ? null : Chains.receiver(call.getTarget());
        if (receiverName == null && fieldType == null && ref != null && ref.getDeclaringType() != null)
            receiverName = Names.qualified(ref.getDeclaringType());
        // A call written without a receiver resolves against the class it is written in (or what that class inherits).
        if (receiverName == null && fieldType == null && call.getTarget() == null)
            receiverName = Names.qualified(type);
        if (fieldType != null) receiverName = fieldType;

        List<String> targets = targets(ref, index, receiverName, name, argc);
        boolean generated = false;
        if (targets.isEmpty()) {
            // Unqualified call: its receiver is the class being written, so a generated sibling is the target.
            String generatedOwner = receiverName != null ? receiverName : Names.qualified(type);
            String id = index.generated().getOrDefault(generatedOwner, java.util.Map.of()).get(name + "/" + argc);
            if (id != null) {
                targets = List.of(id);
                generated = true;
                receiverName = generatedOwner;
            }
        }

        g.writeStringField("method", methodId);
        g.writeStringField("file", pos == null ? "" : pos.file());
        g.writeNumberField("line", pos == null ? 0 : pos.line());
        g.writeNumberField("col", pos == null ? 0 : pos.col());
        g.writeStringField("name", name);
        g.writeNumberField("argc", argc);
        g.writeObjectFieldStart("recv");
        if (receiverName == null) g.writeNullField("type");
        else g.writeStringField("type", receiverName);
        g.writeStringField("kind", kind(call));
        g.writeStringField("how", how(call));
        // The receiver as written (`cargoRepository`, `this.x`, `a.b()`), which is how a reader names the site.
        String wrote = targetText == null ? null : targetText.length() > 80 ? targetText.substring(0, 80) : targetText;
        if (wrote == null) g.writeNullField("text");
        else g.writeStringField("text", wrote);
        g.writeEndObject();
        g.writeArrayFieldStart("targets");
        for (String target : targets) g.writeString(target);
        g.writeEndArray();
        // The arguments as written (first two, shortened): a fact quotes what a call was given, not what it returns.
        g.writeArrayFieldStart("args");
        java.util.List<CtExpression<?>> arguments = call.getArguments();
        for (int i = 0; i < Math.min(2, arguments.size()); i++) {
            String text = safeText(arguments.get(i));
            g.writeString(text == null ? "" : text.length() > 80 ? text.substring(0, 80) : text);
        }
        g.writeEndArray();

        boolean receiverDeclared = receiverName != null && index.declared().contains(receiverName);
        boolean invented = receiverName != null && fieldType == null && !receiverDeclared && samePackage(receiverName, type);
        // `arity` is a member lookup by name and count inside a project type, not a compiler answer: it says so.
        boolean compiler = ref != null && ref.getDeclaration() instanceof CtMethod<?> declaredMethod
                && declaredMethod.getDeclaringType() != null
                && index.declared().contains(Names.qualified(declaredMethod.getDeclaringType()));
        // A generated field (Lombok's `log`) is a library receiver even when Spoon never saw the field declaration.
        boolean generatedField = fieldType != null;
        boolean libraryTarget = ref != null && ref.getDeclaration() instanceof CtMethod<?> declaredCall
                && (declaredCall.getDeclaringType() == null
                        || !index.declared().contains(Names.qualified(declaredCall.getDeclaringType())));
        g.writeStringField("origin", !targets.isEmpty() ? generated ? "lombok" : compiler ? "java" : "arity"
                : invented ? "unresolved"
                : generatedField || libraryTarget ? "library"
                : receiverName == null || receiverDeclared ? "unresolved" : "library");
        if (targets.isEmpty())
            g.writeStringField("reason", invented ? "unresolved-name"
                    : receiverName == null ? "no-callee"
                    : receiverDeclared ? "no-declaration-here" : "library-signature");
    }

    /** The receiver and the type it is declared with share a package: a name Spoon invented, not a library type. */
    private static boolean samePackage(String fqn, CtType<?> type) {
        if (type.getPackage() == null) return false;
        int dot = fqn.lastIndexOf('.');
        return dot > 0 && type.getPackage().getQualifiedName().equals(fqn.substring(0, dot));
    }

    /** Printing an expression Spoon cannot resolve can throw; a name we cannot read is simply absent. */
    private static String safeText(CtExpression<?> expression) {
        if (expression == null) return null;
        try {
            return expression.toString();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static void writeCalls(Ndjson w, CtType<?> type, CtExecutable<?> executable, String methodId, Index index,
            Path root) throws IOException {
        for (CtInvocation<?> call : executable.getElements(
                new spoon.reflect.visitor.filter.TypeFilter<>(CtInvocation.class))) {
            // Spoon inserts an implicit super() with no source position; it is not a call anyone wrote.
            Positions.Pos pos = Positions.of(call, root);
            if (pos == null) continue;
            try {
                w.row(g -> row(g, type, executable, methodId, call, pos, index, root));
            } catch (RuntimeException e) {
                // One element Spoon cannot type must not end a 5,000-file dump: name it, keep going.
                w.row(g -> errorRow(g, type, executable, call, pos, e));
            }
        }
    }

    /** A constructor is named after its type in every id the model uses; Spoon's own simple name is `<init>`. */
    private static String methodIdOf(CtType<?> type, CtExecutable<?> owner) {
        String name = owner instanceof spoon.reflect.declaration.CtConstructor<?>
                ? type.getSimpleName() : owner.getSimpleName();
        return Names.methodId(type, name, paramTypes(owner));
    }

    /** A site Spoon refused to type: recorded with its reason, never silently dropped and never guessed. */
    private static void errorRow(JsonGenerator g, CtType<?> type, CtExecutable<?> owner, CtInvocation<?> call,
            Positions.Pos pos, RuntimeException e) throws IOException {
        String name = "?";
        try {
            name = call.getExecutable() == null ? "?" : call.getExecutable().getSimpleName();
        } catch (RuntimeException ignored) {
            // the name is worth having but not worth failing for
        }
        g.writeStringField("method", methodIdOf(type, owner));
        g.writeStringField("file", pos.file());
        g.writeNumberField("line", pos.line());
        g.writeNumberField("col", pos.col());
        g.writeStringField("name", name);
        g.writeNumberField("argc", call.getArguments().size());
        g.writeObjectFieldStart("recv");
        g.writeNullField("type");
        g.writeStringField("kind", "unknown");
        g.writeEndObject();
        g.writeArrayFieldStart("targets");
        g.writeEndArray();
        g.writeStringField("origin", "error");
        g.writeStringField("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
    }

    /**
     * How the receiver was reached, in the vocabulary the facts already speak: a field, a parameter, a local, a chain, a
     * static type, `super`, `this`, or nothing written at all (implicit).
     */
    private static String how(CtInvocation<?> call) {
        CtExpression<?> target = call.getTarget();
        if (call.getTarget() == null) return "implicit";
        if (target instanceof spoon.reflect.code.CtTypeAccess<?>) return "static";
        if (target instanceof spoon.reflect.code.CtSuperAccess<?>) return "super";
        if (target instanceof spoon.reflect.code.CtThisAccess<?>) return "this";
        if (target instanceof spoon.reflect.code.CtInvocation<?>) return "chain";
        if (target instanceof spoon.reflect.code.CtVariableRead<?> read) {
            var declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
            if (declaration instanceof spoon.reflect.declaration.CtField<?>) return "field";
            if (declaration instanceof spoon.reflect.declaration.CtParameter<?> parameter)
                // A lambda's parameter is a parameter to Spoon; the facts distinguish it, so the dump does too.
                return parameter.getParent() instanceof spoon.reflect.code.CtLambda<?> ? "lambda" : "param";
            if (declaration instanceof spoon.reflect.code.CtLocalVariable<?>) return "local";
            return "local";
        }
        return "expr";
    }

    private static String kind(CtInvocation<?> call) {
        CtExecutableReference<?> ref = call.getExecutable();
        if (call.getTarget() == null) return ref != null && ref.isStatic() ? "static" : "implicit";
        if (call.getTarget() instanceof spoon.reflect.code.CtSuperAccess<?>) return "super";
        if (call.getTarget() instanceof spoon.reflect.code.CtTypeAccess<?>) return "static";
        return "instance";
    }

    /** The declaration's id, when it is a declaration in this checkout (a real position); null otherwise. */
    /**
     * The declaration, then every implementation of it: a call through an interface reaches each subclass method with
     * the same name and arity, which is the graph a flow has to walk.
     */
    private static List<String> targets(CtExecutableReference<?> ref, Index index, String receiver,
            String name, int argc) {
        List<String> out = new ArrayList<>();
        if (ref == null) return out;
        var declaration = ref.getDeclaration();
        if (!(declaration instanceof CtMethod<?> method)) {
            // Spoon refuses an overload it cannot pick; inside a project type, name and arity are still a fact when they
            // leave exactly one member. Marked by origin, never dressed up as a compiler answer.
            if (receiver == null || !index.declared().contains(receiver)) return out;
            // The call may sit on an inherited member: nearest declaration wins, one level at a time.
            java.util.List<String> level = java.util.List.of(receiver);
            java.util.Set<String> seen = new java.util.HashSet<>();
            while (!level.isEmpty() && out.isEmpty()) {
                java.util.List<String> next = new java.util.ArrayList<>();
                for (String owner : level) {
                    if (!seen.add(owner)) continue;
                    String id = index.arity().getOrDefault(owner, java.util.Map.of()).get(name + "/" + argc);
                    if (id != null && !out.contains(id)) out.add(id);
                    next.addAll(index.supertypes().getOrDefault(owner, java.util.Set.of()));
                }
                level = next;
            }
            return out;
        }
        CtType<?> owner = method.getDeclaringType();
        if (owner == null || !index.declared().contains(Names.qualified(owner))) return out;
        // The method's own position can be synthetic (a record accessor); the owner's is the check that matters.
        if (owner.getPosition() == null || !owner.getPosition().isValidPosition()) return out;
        if (syntheticEnum(owner, method.getSimpleName())) return out;
        out.add(Names.methodId(owner, method.getSimpleName(), paramTypes(method)));
        boolean open = owner.isInterface() || owner.getModifiers().contains(spoon.reflect.declaration.ModifierKind.ABSTRACT);
        if (!open) return out;
        String shape = method.getSimpleName() + "/" + method.getParameters().size();
        for (String subtype : index.subtypes().getOrDefault(Names.qualified(owner), java.util.Set.of())) {
            String id = index.methods().getOrDefault(subtype, java.util.Map.of()).get(shape);
            if (id != null && !out.contains(id)) out.add(id);
        }
        return out;
    }

    private static List<CtTypeReference<?>> paramTypes(CtExecutable<?> executable) {
        List<CtTypeReference<?>> out = new ArrayList<>();
        for (var p : executable.getParameters()) out.add(p.getType());
        return out;
    }
}
