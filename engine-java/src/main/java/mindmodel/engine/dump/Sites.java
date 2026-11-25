package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtExecutableReference;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * calls.ndjson: every call site and method reference inside a dumped type's body, with the receiver's static type and
 * the declaration it resolves to. A target is only written when the declaration is in this checkout; a library call is
 * named as such, never guessed. Anonymous and local class bodies are inside their enclosing method's span, so their
 * calls belong to it.
 *
 * Each row carries an {@code id}: an argument that is a call names that row, so the argument graph is a lookup.
 * {@code inLambda} marks a site inside a lambda (it may run later, or never); {@code via: methodRef} marks a method
 * reference, whose {@code argc} is the referenced method's parameter count.
 *
 * The call rows add three things a reader needs and Spoon can answer: {@code recv.typeArgs}, the type arguments the
 * receiver's declared type is written with at the site (`[shop.Voucher]` for `Base<Voucher>.publish`); {@code targets}
 * as {@code {id, kind}} with {@code declared} for the member Spoon resolved and {@code override} for each implementation
 * of it in a subtype; and {@code uniqueImpl}, true only when the declaration has no body and exactly one override.
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
            java.util.Map<String, java.util.Map<String, String>> arity,
            // `ownerFqn#T -> bound fqn`, only where every subtype that names the type writes the same argument.
            java.util.Map<String, String> bound) {
    }

    /** One target of a call: the declaration Spoon resolved, or an override of it in a subtype declared here. */
    record Target(String id, String kind) {
    }

    private static Index index(List<CtType<?>> types, java.util.Map<String, List<Lombok.Item>> synth,
            Failures failures) {
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
                        ? t.getSimpleName() : e.getSimpleName(), paramTypes(t, e));
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
            if (t instanceof spoon.reflect.declaration.CtRecord record) {
                int n = record.getRecordComponents().size();
                String shape = "<init>/" + n;
                // Spoon 11.5 models no canonical constructor for a nested record: the constructor member is still
                // declared, so a `new` of that arity resolves to it unless another constructor shares the arity.
                if (!byArity.containsKey(shape) && !ambiguous.contains(shape))
                    byArity.put(shape, RecordCtors.id(record));
            }
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
        // `Foo.<T>builder()` is written with a type argument Spoon counts as an argument: a generated member whose
        // name has exactly one shape on its owner is also reachable without the count.
        for (var e : synth.entrySet()) {
            java.util.Map<String, java.util.List<String>> byName = new java.util.HashMap<>();
            for (Lombok.Item item : e.getValue())
                if ("method".equals(item.kind()))
                    byName.computeIfAbsent(item.name(), k -> new java.util.ArrayList<>()).add(item.id());
            for (var named : byName.entrySet())
                if (named.getValue().size() == 1)
                    generated.computeIfAbsent(e.getKey(), k -> new java.util.HashMap<>())
                            .putIfAbsent(named.getKey(), named.getValue().get(0));
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
        return new Index(declared, subtypes, supertypes, methods, generated, generatedFields, arity,
                bindings(types, declared, failures));
    }

    /**
     * The type arguments this checkout settles. `VoucherService extends Base<Voucher>` binds `Base`'s `T` to
     * `shop.Voucher`; a type parameter written as the argument (`class Sub<U> extends Base<U>`) or a type whose two
     * subtypes disagree binds nothing. Only arguments declared here count: a member reached through a parameter bound
     * to a type outside the checkout is still unresolved, because nothing in this dump can say what that type is.
     */
    private static java.util.Map<String, String> bindings(List<CtType<?>> types, java.util.Set<String> declared,
            Failures failures) {
        java.util.Map<String, java.util.Set<String>> seen = new java.util.HashMap<>();
        for (CtType<?> t : types) {
            try {
                List<CtTypeReference<?>> supers = new ArrayList<>(t.getSuperInterfaces());
                if (t instanceof spoon.reflect.declaration.CtClass<?> c && c.getSuperclass() != null)
                    supers.add(c.getSuperclass());
                for (CtTypeReference<?> superRef : supers) bindingOf(superRef, declared, seen);
            } catch (RuntimeException e) {
                // One type Spoon cannot read must not cost the dump the bindings of every other type.
                failures.count("sites.bindingsUnresolved");
            }
        }
        java.util.Map<String, String> out = new java.util.HashMap<>();
        for (var e : seen.entrySet()) if (e.getValue().size() == 1) out.put(e.getKey(), e.getValue().iterator().next());
        return out;
    }

    private static void bindingOf(CtTypeReference<?> superRef, java.util.Set<String> declared,
            java.util.Map<String, java.util.Set<String>> seen) {
        CtType<?> declaration = superRef.getTypeDeclaration();
        if (declaration == null || !declared.contains(Names.qualified(declaration))) return;
        List<CtTypeReference<?>> args = superRef.getActualTypeArguments();
        var params = declaration.getFormalCtTypeParameters();
        for (int i = 0; i < params.size() && i < args.size(); i++) {
            CtTypeReference<?> arg = args.get(i);
            if (arg == null || arg instanceof CtTypeParameterReference) continue;
            String fqn = Names.qualified(arg);
            if (!declared.contains(fqn)) continue;
            String key = Names.qualified(declaration) + "#" + params.get(i).getSimpleName();
            seen.computeIfAbsent(key, k -> new java.util.TreeSet<>()).add(fqn);
        }
    }

    /**
     * The type a receiver declared as a type parameter has here: the one argument this checkout writes for it, or
     * null when there is no such answer. The parameter is looked up on the type the body is written in, or an
     * enclosing one, because a nested type inherits its outer class's parameters.
     */
    private static String boundType(Index index, CtType<?> type, CtTypeReference<?> reference) {
        if (!(reference instanceof CtTypeParameterReference parameter)) return null;
        for (CtType<?> owner = type; owner != null; owner = owner.getDeclaringType())
            for (var formal : owner.getFormalCtTypeParameters())
                if (formal.getSimpleName().equals(parameter.getSimpleName()))
                    return index.bound().get(Names.qualified(owner) + "#" + parameter.getSimpleName());
        return null;
    }

    /**
     * Writes calls.ndjson and hands the rest of each body to the sections that read it: the returns to the member rows,
     * the field accesses to fields.ndjson. One walk per body feeds all three.
     *
     * <p>`types` are the dumped ones; `known` adds the generated sources' signatures, which the index needs so a call
     * into a generated mapper is typed like any other, and which are never walked.
     */
    static Written write(List<CtType<?>> types, List<CtType<?>> known, java.util.Map<String, List<Lombok.Item>> synth,
            Path root, Path out, CallIds ids, Refs refs) throws IOException {
        Index index = index(known, synth, refs.failures());
        // What Lombok writes, in the two shapes a chain needs: a member's return type, and the builder types it invents.
        java.util.Map<String, String> generatedTypes = new java.util.HashMap<>();
        java.util.Set<String> builders = new java.util.HashSet<>();
        for (var entry : synth.entrySet()) {
            java.util.Map<String, java.util.List<String>> byName = new java.util.HashMap<>();
            for (Lombok.Item item : entry.getValue()) {
                String type = item.typeFqn() != null ? item.typeFqn() : item.type();
                if ("method".equals(item.kind())) {
                    generatedTypes.put(item.owner() + "#" + item.name() + "/" + item.params().size(), type);
                    if (type != null) byName.computeIfAbsent(item.name(), k -> new java.util.ArrayList<>()).add(type);
                } else if ("field".equals(item.kind())) generatedTypes.put(item.owner() + "#" + item.name(), type);
                if (type != null && type.endsWith(".Builder")) builders.add(type);
            }
            // `Foo.<T>builder()`: Spoon counts the written type argument, so a single-shape name is also reachable bare.
            for (var named : byName.entrySet())
                if (named.getValue().size() == 1)
                    generatedTypes.putIfAbsent(entry.getKey() + "#" + named.getKey(), named.getValue().get(0));
        }
        Chains chains = new Chains(generatedTypes, builders, refs.failures());
        java.util.Map<CtExecutable<?>, List<Returns.Entry>> returns = new java.util.IdentityHashMap<>();
        List<FieldAccesses.Row> fields = FieldAccesses.rows();
        try (Ndjson w = new Ndjson(out)) {
            for (CtType<?> type : types) {
                for (CtExecutable<?> executable : executables(type))
                    writeBody(w, type, executable, methodIdOf(type, executable), root, index, chains, ids, refs,
                            returns, fields);
                // A method of an anonymous class is body work of the member that writes it, filed under the type.
                for (spoon.reflect.declaration.CtTypeMember member : type.getTypeMembers())
                    if (member instanceof CtExecutable<?> body)
                        for (CtMethod<?> inner : Anonymous.methods(body))
                            writeBody(w, type, inner, Anonymous.id(type, inner, root), root, index, chains, ids, refs,
                                    returns, fields);
            }
        }
        return new Written(returns, fields);
    }

    /** What one dump knows beyond its sections: each body's returns, and every field read and write. */
    record Written(java.util.Map<CtExecutable<?>, List<Returns.Entry>> returns, List<FieldAccesses.Row> fields) {
    }

    /** A site with the position it was read at, so the position is computed once. */
    private record Site(CtElement element, Positions.Pos pos) {
    }

    private static void writeBody(Ndjson w, CtType<?> type, CtExecutable<?> executable, String methodId, Path root,
            Index index, Chains chains, CallIds ids, Refs refs,
            java.util.Map<CtExecutable<?>, List<Returns.Entry>> returns, List<FieldAccesses.Row> fields)
            throws IOException {
        Walk.Body body = Walk.scan(executable);
        // The body's own writes first: a returned local can still name the value it was assigned.
        refs.scope(body.writes());
        // Ids for the whole body before its rows: a row's argument may name a call written after it.
        List<Site> sites = new ArrayList<>();
        for (CtElement element : body.sites()) {
            // Spoon inserts an implicit super() with no source position; it is not a call anyone wrote.
            Positions.Pos pos = Positions.of(element, root);
            if (pos == null) continue;
            ids.assign(element, methodId, pos);
            sites.add(new Site(element, pos));
        }
        for (Site site : sites) writeSite(w, type, site.element(), site.pos(), methodId, index, chains, ids, refs);
        returns.put(executable, Returns.plan(executable, body, refs));
        FieldAccesses.collect(fields, body, methodId, root, refs);
    }

    private static void writeSite(Ndjson w, CtType<?> type, CtElement site, Positions.Pos pos, String methodId,
            Index index, Chains chains, CallIds ids, Refs refs) throws IOException {
        try {
            if (site instanceof CtInvocation<?> call) w.row(g -> row(g, type, methodId, call, pos, index, chains, ids, refs));
            else if (site instanceof CtExecutableReferenceExpression<?, ?> ref)
                w.row(g -> methodRefRow(g, type, methodId, ref, pos, index, chains, ids, refs));
        } catch (RuntimeException e) {
            // One element Spoon cannot type must not end a 5,000-file dump: name it, keep going.
            w.row(g -> errorRow(g, methodId, site, pos, e, refs.failures()));
        }
    }

    /** `values()`/`valueOf(String)` on an enum are compiler-written: never a member, never a target. */
    private static boolean syntheticEnum(CtType<?> owner, String name) {
        return owner.isEnum() && ("values".equals(name) || "valueOf".equals(name));
    }

    static List<CtExecutable<?>> executables(CtType<?> type) {
        List<CtExecutable<?>> out = new ArrayList<>();
        for (var member : type.getTypeMembers())
            if (member instanceof spoon.reflect.declaration.CtConstructor<?> ctor) out.add(ctor);
            else if (member instanceof CtMethod<?> method) out.add(method);
        return out;
    }

    private static void row(JsonGenerator g, CtType<?> type, String methodId, CtInvocation<?> call, Positions.Pos pos,
            Index index, Chains chains, CallIds ids, Refs refs) throws IOException {
        CtExecutableReference<?> ref = call.getExecutable();
        String name = ref == null ? "?" : ref.getSimpleName();
        int argc = call.getArguments().size();
        String targetText = refs.textOf(call.getTarget());
        // Lombok's `log` is a field nobody declared: the target is a bare name, and the synthesis knows its type.
        String fieldType = targetText != null && targetText.matches("[A-Za-z_$][\\w$]*")
                ? index.generatedFields().get(Names.qualified(type) + "#" + targetText) : null;
        // The receiver, chains included: a library call's return type is the only way to type what follows it.
        String receiverName = call.getTarget() == null ? null : chains.receiver(call.getTarget());
        if (receiverName == null && fieldType == null && ref != null && ref.getDeclaringType() != null)
            receiverName = Names.qualified(ref.getDeclaringType());
        // A call written without a receiver resolves against the class it is written in (or what that class inherits).
        if (receiverName == null && fieldType == null && call.getTarget() == null)
            receiverName = Names.qualified(type);
        if (fieldType != null) receiverName = fieldType;
        // A receiver declared as a type parameter (`T row`) is typed as the argument this checkout writes for it, and
        // stays untyped when there is none: a member reached through an open parameter is unresolved.
        if (receiverName == null && fieldType == null && call.getTarget() != null)
            receiverName = boundType(index, type, call.getTarget().getType());

        List<Target> targets = targets(ref, index, receiverName, name, argc);
        boolean generated = false;
        if (targets.isEmpty()) {
            // Unqualified call: its receiver is the class being written, so a generated sibling is the target.
            String generatedOwner = receiverName != null ? receiverName : Names.qualified(type);
            java.util.Map<String, String> members = index.generated().getOrDefault(generatedOwner, java.util.Map.of());
            String id = members.get(name + "/" + argc);
            if (id == null) id = members.get(name);
            if (id != null) {
                targets = List.of(new Target(id, "declared"));
                generated = true;
                receiverName = generatedOwner;
            }
        }

        g.writeStringField("method", methodId);
        g.writeStringField("id", ids.id(call));
        g.writeStringField("file", pos.file());
        g.writeNumberField("line", pos.line());
        g.writeNumberField("col", pos.col());
        g.writeStringField("name", name);
        g.writeNumberField("argc", argc);
        g.writeObjectFieldStart("recv");
        if (receiverName == null) g.writeNullField("type");
        else g.writeStringField("type", receiverName);
        writeTypeArgs(g, call.getTarget() == null ? null : call.getTarget().getType(), refs);
        g.writeStringField("kind", kind(call));
        g.writeStringField("how", how(call.getTarget()));
        // The receiver as written (`cargoRepository`, `this.x`, `a.b()`), which is how a reader names the site.
        if (targetText == null) g.writeNullField("text");
        else g.writeStringField("text", targetText);
        g.writeEndObject();
        writeTargets(g, targets);
        g.writeBooleanField("uniqueImpl", uniqueImpl(ref, targets));
        // Every argument, as data: `text` is for display, `kind` and its fields are the fact.
        g.writeArrayFieldStart("args");
        for (CtExpression<?> argument : call.getArguments()) {
            g.writeStartObject();
            Refs.write(g, refs.of(argument));
            g.writeEndObject();
        }
        g.writeEndArray();
        if (call.getParent(spoon.reflect.code.CtLambda.class) != null) g.writeBooleanField("inLambda", true);

        boolean receiverDeclared = receiverName != null && index.declared().contains(receiverName);
        boolean builderReceiver = chains.isBuilder(receiverName);
        boolean invented = receiverName != null && fieldType == null && !receiverDeclared && !builderReceiver
                && samePackage(receiverName, type);
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
                : builderReceiver ? "lombok"
                : invented ? "unresolved"
                : generatedField || libraryTarget ? "library"
                : receiverName == null || receiverDeclared ? "unresolved" : "library");
        if (targets.isEmpty())
            g.writeStringField("reason", builderReceiver ? "lombok-builder"
                    : invented ? "unresolved-name"
                    : receiverName == null ? (varLocal(call.getTarget()) ? "var-unresolved" : "no-callee")
                    : receiverDeclared ? "no-declaration-here" : "library-signature");
    }

    /**
     * A method reference (`Cookie::getValue`, `cookie::getValue`) as a call row: the same receiver type and target as a
     * call would have, with `via: methodRef` and the referenced method's arity. It has no arguments of its own.
     */
    private static void methodRefRow(JsonGenerator g, CtType<?> type, String methodId,
            CtExecutableReferenceExpression<?, ?> expression, Positions.Pos pos, Index index, Chains chains,
            CallIds ids, Refs refs) throws IOException {
        CtExecutableReference<?> ref = expression.getExecutable();
        String name = ref == null ? "?" : ref.getSimpleName();
        var declaration = ref == null ? null : ref.getDeclaration();
        int argc = declaration instanceof CtMethod<?> method ? method.getParameters().size() : 0;
        CtExpression<?> target = expression.getTarget();
        String receiverName = target == null ? null : chains.receiver(target);
        if (receiverName == null && ref != null && ref.getDeclaringType() != null)
            receiverName = Names.qualified(ref.getDeclaringType());
        if (receiverName == null) receiverName = Names.qualified(type);
        List<Target> targets = targets(ref, index, receiverName, name, argc);

        g.writeStringField("method", methodId);
        g.writeStringField("id", ids.id(expression));
        g.writeStringField("file", pos.file());
        g.writeNumberField("line", pos.line());
        g.writeNumberField("col", pos.col());
        g.writeStringField("name", name);
        g.writeStringField("via", "methodRef");
        g.writeNumberField("argc", argc);
        g.writeObjectFieldStart("recv");
        g.writeStringField("type", receiverName);
        writeTypeArgs(g, target == null ? null : target.getType(), refs);
        g.writeStringField("kind", ref != null && ref.isStatic() ? "static" : "instance");
        g.writeStringField("how", target == null ? "static" : how(target));
        String text = refs.textOf(expression);
        if (text == null) g.writeNullField("text");
        else g.writeStringField("text", text);
        g.writeEndObject();
        writeTargets(g, targets);
        g.writeBooleanField("uniqueImpl", uniqueImpl(ref, targets));
        g.writeArrayFieldStart("args");
        g.writeEndArray();
        if (expression.getParent(spoon.reflect.code.CtLambda.class) != null)
            g.writeBooleanField("inLambda", true);
        boolean receiverDeclared = index.declared().contains(receiverName);
        boolean unknownVar = varLocal(target);
        g.writeStringField("origin", !targets.isEmpty() ? "java"
                : receiverDeclared || unknownVar ? "unresolved" : "library");
        if (targets.isEmpty())
            g.writeStringField("reason",
                    receiverDeclared ? "no-declaration-here"
                            : unknownVar ? "var-unresolved" : "library-signature");
    }

    /** True when a receiver is a `var` local: an unresolved one is an unknown, not a missing callee. */
    private static boolean varLocal(CtExpression<?> target) {
        if (!(target instanceof spoon.reflect.code.CtVariableRead<?> read)) return false;
        var declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
        return declaration instanceof spoon.reflect.code.CtLocalVariable<?> local && local.isInferred();
    }

    /** `targets`: the declaration and each override of it, in that order, each with which of the two it is. */
    private static void writeTargets(JsonGenerator g, List<Target> targets) throws IOException {
        g.writeArrayFieldStart("targets");
        for (Target target : targets) {
            g.writeStartObject();
            g.writeStringField("id", target.id());
            g.writeStringField("kind", target.kind());
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    /**
     * The type arguments of a written type, as names: a project or library type qualified, a type parameter by the
     * letter its author wrote. Sorted by nothing — the order is Java's — and empty when the type has no arguments.
     */
    private static void writeTypeArgs(JsonGenerator g, CtTypeReference<?> type, Refs refs) throws IOException {
        g.writeArrayFieldStart("typeArgs");
        for (String name : refs.typeArgs(type)) g.writeString(name);
        g.writeEndArray();
    }

    /**
     * True when the call reaches an open declaration with no body and exactly one override here: the one case where
     * "the implementation" is a fact, and the case Node follows. With two overrides it is false, and a reader that
     * follows implementations must not pick one.
     */
    private static boolean uniqueImpl(CtExecutableReference<?> ref, List<Target> targets) {
        int overrides = 0;
        for (Target target : targets) if ("override".equals(target.kind())) overrides++;
        if (overrides != 1 || targets.size() != 2) return false;
        var declaration = ref == null ? null : ref.getDeclaration();
        return declaration instanceof CtMethod<?> method && method.getBody() == null;
    }

    /** The receiver and the type it is declared with share a package: a name Spoon invented, not a library type. */
    private static boolean samePackage(String fqn, CtType<?> type) {
        if (type.getPackage() == null) return false;
        int dot = fqn.lastIndexOf('.');
        return dot > 0 && type.getPackage().getQualifiedName().equals(fqn.substring(0, dot));
    }

    static String methodIdOf(CtType<?> type, CtExecutable<?> owner) {
        String name = owner instanceof spoon.reflect.declaration.CtConstructor<?>
                ? type.getSimpleName() : owner.getSimpleName();
        return Names.methodId(type, name, paramTypes(type, owner));
    }

    /** A site Spoon refused to type: recorded with its reason, never silently dropped and never guessed. */
    private static void errorRow(JsonGenerator g, String methodId, CtElement site, Positions.Pos pos,
            RuntimeException e, Failures failures) throws IOException {
        String name = "?";
        try {
            CtExecutableReference<?> ref = site instanceof CtInvocation<?> call ? call.getExecutable()
                    : site instanceof CtExecutableReferenceExpression<?, ?> expression ? expression.getExecutable()
                    : null;
            name = ref == null ? "?" : ref.getSimpleName();
        } catch (RuntimeException ignored) {
            // the name is worth having but not worth failing for
            failures.count("sites.nameUnresolved");
        }
        g.writeStringField("method", methodId);
        g.writeNullField("id");
        g.writeStringField("file", pos.file());
        g.writeNumberField("line", pos.line());
        g.writeNumberField("col", pos.col());
        g.writeStringField("name", name);
        g.writeNumberField("argc", site instanceof CtInvocation<?> call ? call.getArguments().size() : 0);
        g.writeObjectFieldStart("recv");
        g.writeNullField("type");
        g.writeStringField("kind", "unknown");
        g.writeEndObject();
        g.writeArrayFieldStart("targets");
        g.writeEndArray();
        g.writeBooleanField("uniqueImpl", false);
        g.writeArrayFieldStart("args");
        g.writeEndArray();
        g.writeStringField("origin", "error");
        g.writeStringField("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
    }

    /**
     * How the receiver was reached, in the vocabulary the facts already speak: a field, a parameter, a local, a chain, a
     * static type, `super`, `this`, or nothing written at all (implicit).
     */
    private static String how(CtExpression<?> target) {
        if (target == null) return "implicit";
        if (target instanceof spoon.reflect.code.CtTypeAccess<?>) return "static";
        if (target instanceof spoon.reflect.code.CtSuperAccess<?>) return "super";
        if (target instanceof spoon.reflect.code.CtThisAccess<?>) return "this";
        if (target instanceof CtInvocation<?>) return "chain";
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

    /**
     * The declaration, then every implementation of it: a call through an interface reaches each subclass method with
     * the same name and arity, which is the graph a flow has to walk. The declaration is `declared`, each subtype
     * method `override`: which of the two a reader may follow is its policy, and this file only says which is which.
     */
    private static List<Target> targets(CtExecutableReference<?> ref, Index index, String receiver,
            String name, int argc) {
        List<Target> out = new ArrayList<>();
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
                    if (id != null && out.stream().noneMatch(t -> t.id().equals(id)))
                        out.add(new Target(id, "declared"));
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
        out.add(new Target(Names.methodId(owner, method.getSimpleName(), paramTypes(owner, method)), "declared"));
        boolean open = owner.isInterface() || owner.getModifiers().contains(spoon.reflect.declaration.ModifierKind.ABSTRACT);
        if (!open) return out;
        String shape = method.getSimpleName() + "/" + method.getParameters().size();
        for (String subtype : index.subtypes().getOrDefault(Names.qualified(owner), java.util.Set.of())) {
            String id = index.methods().getOrDefault(subtype, java.util.Map.of()).get(shape);
            if (id != null && out.stream().noneMatch(t -> t.id().equals(id))) out.add(new Target(id, "override"));
        }
        return out;
    }

    private static List<CtTypeReference<?>> paramTypes(CtType<?> owner, CtExecutable<?> executable) {
        // A record's canonical constructor is identified by its components, in declaration order: Spoon lists them in
        // another order, and a row written under that order would not match the member the dump declares.
        if (owner instanceof spoon.reflect.declaration.CtRecord record
                && executable instanceof spoon.reflect.declaration.CtConstructor<?> ctor
                && RecordCtors.isCanonical(record, ctor)) return RecordCtors.componentTypes(record);
        List<CtTypeReference<?>> out = new ArrayList<>();
        for (var p : executable.getParameters()) out.add(p.getType());
        return out;
    }
}
