package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtSuperAccess;
import spoon.reflect.code.CtThisAccess;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtRecordComponent;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
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

    /** One target of a call: the declaration Spoon resolved, or an override of it in a subtype declared here. */
    record Target(String id, String kind) {
    }

    /** What one dump knows beyond its sections: each body's returns, and every field read and write. */
    record Written(Map<CtExecutable<?>, List<Returns.Entry>> returns, List<FieldAccesses.Row> fields) {
    }

    /**
     * The declarations of the dumped types and their relations, as a call is answered from them. `byShape` and
     * `byArity` are keyed by owner, then by `name/argc`; `bound` is `owner#T -> bound fqn`, only where every subtype that
     * names the type writes the same argument.
     */
    private record Index(Map<String, CtType<?>> types, Set<String> declared, Map<String, Set<String>> subtypes,
            Map<String, Set<String>> supertypes, Map<String, Map<String, String>> byShape,
            Map<String, Map<String, String>> byArity, Lombok.Index generated, Map<String, String> bound) {
    }

    /** What every site row is written with: the index, the run's readers and sinks, and the returns and fields so far. */
    private record Ctx(Index index, Chains chains, CallIds ids, Refs refs, Positions positions,
            Map<CtExecutable<?>, List<Returns.Entry>> returns, List<FieldAccesses.Row> fields) {
    }

    /** A site with the position it was read at, so the position is computed once. */
    private record Site(CtElement element, Positions.Pos pos) {
    }

    /**
     * The receiver of one call, judged: its type when the checkout declares it, whether it is a builder Lombok invented,
     * and whether Spoon invented the name. An invented receiver has no type the dump may give.
     */
    private record Recv(String type, boolean declared, boolean builder, boolean invented, boolean generatedField) {

        static Recv of(Ctx ctx, CtType<?> written, String type, boolean generatedField) {
            boolean declared = type != null && ctx.index().declared().contains(type);
            boolean builder = ctx.chains().isBuilder(type);
            boolean invented = Refs.isInvented(type, declared || builder || generatedField, written);
            if (invented) ctx.refs().failures().count(Refs.UNRESOLVED);
            return new Recv(type, declared, builder, invented, generatedField);
        }
    }

    /**
     * Writes calls.ndjson and hands the rest of each body to the sections that read it: the returns to the member rows,
     * the field accesses to fields.ndjson. One walk per body feeds all three.
     *
     * <p>`types` are the dumped ones; `known` adds the generated sources' signatures, which the index needs so a call
     * into a generated mapper is typed like any other, and which are never walked.
     */
    static Written write(List<CtType<?>> types, List<CtType<?>> known, Lombok.Index generated, Walk.Bodies bodies,
            Positions positions, Path out, CallIds ids, Refs refs) throws IOException {
        Ctx ctx = new Ctx(index(known, generated, refs.failures()), new Chains(generated, refs.failures()), ids, refs,
                positions, new IdentityHashMap<>(), FieldAccesses.rows());
        try (Ndjson w = new Ndjson(out)) {
            for (CtType<?> type : types) {
                for (CtExecutable<?> executable : Walk.executables(type))
                    writeBody(w, ctx, type, executable, Names.executableId(type, executable),
                            bodies.of(executable), true);
                // A method of an anonymous class is body work of the member that writes it, filed under the type. The
                // member owns the calls and field accesses inside it, so only the method's returns are read here.
                for (Walk.Anon anon : bodies.anonymous(type))
                    writeBody(w, ctx, type, anon.method(), anon.id(), bodies.of(anon.method()), false);
                writeInitializers(w, ctx, type, true);
                writeInitializers(w, ctx, type, false);
            }
        }
        return new Written(ctx.returns(), ctx.fields());
    }

    // ---- the index: what a call can be answered from ----

    private static Index index(List<CtType<?>> known, Lombok.Index generated, Failures failures) {
        Set<String> declared = new HashSet<>();
        Map<String, CtType<?>> types = new HashMap<>();
        Map<String, Map<String, String>> byShape = new HashMap<>();
        Map<String, Map<String, String>> byArity = new HashMap<>();
        for (CtType<?> t : known) {
            String fqn = Names.qualified(t);
            declared.add(fqn);
            types.put(fqn, t);
            Map<String, String> shapes = new HashMap<>();
            Map<String, String> arities = new HashMap<>();
            shapes(t, shapes, arities);
            byShape.put(fqn, shapes);
            byArity.put(fqn, arities);
        }
        return new Index(types, declared, subtypes(known, declared), supertypes(known, declared), byShape, byArity,
                generated, bindings(known, declared, failures));
    }

    /**
     * One type's members by name and arity. `byShape` keeps the first member of each shape; `byArity` keeps only the
     * shapes that name one member, and a varargs method also answers to one argument fewer.
     */
    private static void shapes(CtType<?> t, Map<String, String> byShape, Map<String, String> byArity) {
        Set<String> ambiguous = new HashSet<>();
        for (CtExecutable<?> e : Walk.executables(t)) {
            if (syntheticEnum(t, e.getSimpleName())) continue;
            String id = Names.executableId(t, e);
            int n = e.getParameters().size();
            String shape = Names.shape(e.getSimpleName(), n);
            byShape.putIfAbsent(shape, id);
            if (byArity.containsKey(shape)) ambiguous.add(shape);
            else byArity.put(shape, id);
            if (n > 0 && e.getParameters().get(n - 1).isVarArgs())
                byArity.putIfAbsent(Names.shape(e.getSimpleName(), n - 1), id);
        }
        for (String shape : ambiguous) byArity.remove(shape);
        if (t instanceof CtRecord record) recordShapes(record, byShape, byArity, ambiguous);
    }

    /**
     * A record's canonical constructor by arity, and each component's accessor by name. Spoon 11.5 models no canonical
     * constructor for a nested record: the constructor member is still declared, so a `new` of that arity resolves to
     * it unless another constructor shares the arity.
     */
    private static void recordShapes(CtRecord record, Map<String, String> byShape, Map<String, String> byArity,
            Set<String> ambiguous) {
        String init = Names.shape("<init>", record.getRecordComponents().size());
        if (!byArity.containsKey(init) && !ambiguous.contains(init)) byArity.put(init, RecordCtors.id(record));
        for (CtRecordComponent component : record.getRecordComponents())
            byShape.put(Names.shape(component.getSimpleName(), 0),
                    Names.methodId(record, component.getSimpleName(), List.of()));
    }

    /** Subtypes of every declared type, transitively: a call to an interface lists the types that implement it. */
    private static Map<String, Set<String>> subtypes(List<CtType<?>> known, Set<String> declared) {
        Map<String, Set<String>> subtypes = new HashMap<>();
        for (CtType<?> t : known) {
            String fqn = Names.qualified(t);
            Set<String> seen = new HashSet<>();
            ArrayDeque<CtType<?>> queue = new ArrayDeque<>();
            queue.add(t);
            while (!queue.isEmpty()) {
                for (CtTypeReference<?> s : supers(queue.poll())) {
                    String superFqn = Names.qualified(s);
                    if (!declared.contains(superFqn) || !seen.add(superFqn)) continue;
                    subtypes.computeIfAbsent(superFqn, k -> new TreeSet<>()).add(fqn);
                    CtType<?> declaration = s.getTypeDeclaration();
                    if (declaration != null) queue.add(declaration);
                }
            }
        }
        return subtypes;
    }

    /** The other direction: which declared types a type inherits from, for a call written without a receiver. */
    private static Map<String, Set<String>> supertypes(List<CtType<?>> known, Set<String> declared) {
        Map<String, Set<String>> supertypes = new HashMap<>();
        for (CtType<?> t : known) {
            Set<String> supers = new TreeSet<>();
            for (CtTypeReference<?> superRef : supers(t)) {
                String superFqn = Names.qualified(superRef);
                if (declared.contains(superFqn)) supers.add(superFqn);
            }
            supertypes.put(Names.qualified(t), supers);
        }
        return supertypes;
    }

    /** A type's written supertypes: its interfaces, then its superclass when it is a class with one. */
    private static List<CtTypeReference<?>> supers(CtType<?> t) {
        List<CtTypeReference<?>> out = new ArrayList<>(t.getSuperInterfaces());
        if (t instanceof CtClass<?> c && c.getSuperclass() != null) out.add(c.getSuperclass());
        return out;
    }

    /**
     * The type arguments this checkout settles. `VoucherService extends Base<Voucher>` binds `Base`'s `T` to
     * `shop.Voucher`; a type parameter written as the argument (`class Sub<U> extends Base<U>`) or a type whose two
     * subtypes disagree binds nothing. Only arguments declared here count: a member reached through a parameter bound
     * to a type outside the checkout is still unresolved, because nothing in this dump can say what that type is.
     */
    private static Map<String, String> bindings(List<CtType<?>> known, Set<String> declared, Failures failures) {
        Map<String, Set<String>> seen = new HashMap<>();
        for (CtType<?> t : known) {
            try {
                for (CtTypeReference<?> superRef : supers(t)) bindingOf(superRef, declared, seen);
            } catch (RuntimeException e) {
                // One type Spoon cannot read must not cost the dump the bindings of every other type.
                failures.count("sites.bindingsUnresolved");
            }
        }
        Map<String, String> out = new HashMap<>();
        for (var e : seen.entrySet()) if (e.getValue().size() == 1) out.put(e.getKey(), e.getValue().iterator().next());
        return out;
    }

    private static void bindingOf(CtTypeReference<?> superRef, Set<String> declared, Map<String, Set<String>> seen) {
        CtType<?> declaration = superRef.getTypeDeclaration();
        if (declaration == null || !declared.contains(Names.qualified(declaration))) return;
        List<CtTypeReference<?>> args = superRef.getActualTypeArguments();
        var params = declaration.getFormalCtTypeParameters();
        for (int i = 0; i < params.size() && i < args.size(); i++) {
            CtTypeReference<?> arg = args.get(i);
            if (arg == null || arg instanceof CtTypeParameterReference) continue;
            String fqn = Names.qualified(arg);
            if (!declared.contains(fqn)) continue;
            String key = Names.member(Names.qualified(declaration), params.get(i).getSimpleName());
            seen.computeIfAbsent(key, k -> new TreeSet<>()).add(fqn);
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
                    return index.bound().get(Names.member(Names.qualified(owner), parameter.getSimpleName()));
        return null;
    }

    // ---- the rows: one body at a time ----

    /**
     * One body's rows and what it hands the other sections. `ownSites` is false for an anonymous class's method, whose
     * calls and field accesses the enclosing member's body already holds.
     */
    private static void writeBody(Ndjson w, Ctx ctx, CtType<?> type, CtExecutable<?> executable, String methodId,
            Walk.Body body, boolean ownSites) throws IOException {
        // The body's own writes first: a returned local can still name the value it was assigned.
        ctx.refs().scope(body.writes());
        if (ownSites) writeSites(w, ctx, type, methodId, body.sites());
        ctx.returns().put(executable, Returns.plan(executable, body, ctx.refs()));
        if (ownSites) FieldAccesses.collect(ctx.fields(), body, methodId, ctx.positions(), ctx.refs());
    }

    /**
     * A type's field initialisers and initializer blocks, owned by a pseudo-member: `<clinit>()` for the static ones and
     * `<init>()` for the ones that run per instance. Their sites are rows like any other.
     */
    private static void writeInitializers(Ndjson w, Ctx ctx, CtType<?> type, boolean statik) throws IOException {
        Walk.Body body = Walk.initializers(type, statik);
        ctx.refs().scope(body.writes());
        String owner = Names.member(Names.qualified(type), statik ? "<clinit>()" : "<init>()");
        writeSites(w, ctx, type, owner, body.sites());
    }

    /** Ids for a body's sites before any of its rows: a row's argument may name a call written after it. */
    private static void writeSites(Ndjson w, Ctx ctx, CtType<?> type, String methodId, List<CtElement> elements)
            throws IOException {
        List<Site> sites = new ArrayList<>();
        for (CtElement element : elements) {
            // Spoon inserts an implicit super() with no source position; it is not a call anyone wrote.
            Positions.Pos pos = ctx.positions().of(element);
            if (pos == null) continue;
            ctx.ids().assign(element, methodId, pos);
            sites.add(new Site(element, pos));
        }
        for (Site site : sites) writeSite(w, ctx, type, methodId, site);
    }

    private static void writeSite(Ndjson w, Ctx ctx, CtType<?> type, String methodId, Site site) throws IOException {
        try {
            if (site.element() instanceof CtInvocation<?> call)
                w.row(g -> callRow(g, ctx, type, methodId, call, site.pos()));
            else if (site.element() instanceof CtExecutableReferenceExpression<?, ?> ref)
                w.row(g -> methodRefRow(g, ctx, type, methodId, ref, site.pos()));
            else if (site.element() instanceof CtConstructorCall<?> created)
                w.row(g -> ctorRow(g, ctx, type, methodId, created, site.pos()));
        } catch (RuntimeException e) {
            // One element Spoon cannot type must not end a 5,000-file dump: name it, keep going.
            w.row(g -> errorRow(g, methodId, ctx.ids().id(site.element()), site.element(), site.pos(), e,
                    ctx.refs().failures()));
        }
    }

    /** One call site: its receiver, what it resolves to, and its arguments. */
    private static void callRow(JsonGenerator g, Ctx ctx, CtType<?> type, String methodId, CtInvocation<?> call,
            Positions.Pos pos) throws IOException {
        CtExecutableReference<?> ref = call.getExecutable();
        String name = ref == null ? null : ref.getSimpleName();
        int argc = call.getArguments().size();
        String targetText = ctx.refs().textOf(call.getTarget());
        String fieldType = generatedFieldType(ctx.index(), type, targetText);
        String receiver = receiverOf(ctx, type, call, fieldType);
        List<Target> targets = targets(ref, ctx.index(), receiver, name, argc);
        Lombok.Item item = null;
        if (targets.isEmpty() && ref != null) {
            // Unqualified call: its receiver is the class being written, so a generated sibling is the target.
            String owner = receiver != null ? receiver : Names.qualified(type);
            item = ctx.index().generated().method(owner, name, argc);
            if (item != null) {
                targets = List.of(new Target(item.id(), "declared"));
                receiver = owner;
            }
        }
        Recv recv = Recv.of(ctx, type, receiver, fieldType != null);
        head(g, methodId, ctx.ids().id(call), "call", pos, name);
        g.writeNumberField("argc", argc);
        writeRecv(g, recv.invented() ? null : recv.type(), ctx, call.getTarget(), kind(call), how(call.getTarget()),
                targetText);
        writeTargets(g, targets);
        g.writeBooleanField("uniqueImpl", uniqueImpl(ref, targets));
        writeArgs(g, ctx, call.getArguments());
        inLambda(g, call);
        g.writeStringField("origin", callOrigin(ctx, targets, item, ref, recv));
        if (targets.isEmpty()) g.writeStringField("reason", callReason(recv, call.getTarget()));
    }

    /**
     * The receiver's type as the call site gives it: a Lombok field's type for a bare name Lombok declared, else the
     * chain or expression's type, else the declaring type of the method, else the class the call is written in.
     */
    private static String receiverOf(Ctx ctx, CtType<?> type, CtInvocation<?> call, String fieldType) {
        CtExecutableReference<?> ref = call.getExecutable();
        CtExpression<?> target = call.getTarget();
        String receiver = target == null ? null : ctx.chains().receiver(target);
        if (receiver == null && fieldType == null && ref != null && ref.getDeclaringType() != null)
            receiver = Names.nameOf(ref.getDeclaringType());
        // A call written without a receiver resolves against the class it is written in (or what that class inherits).
        if (receiver == null && fieldType == null && target == null) receiver = Names.qualified(type);
        if (fieldType != null) receiver = fieldType;
        // A receiver declared as a type parameter (`T row`) is typed as the argument this checkout writes for it, and
        // stays untyped when there is none: a member reached through an open parameter is unresolved.
        if (receiver == null && fieldType == null && target != null)
            receiver = boundType(ctx.index(), type, target.getType());
        return receiver;
    }

    /** The type of a bare name Lombok declared as a field (`log`), or null: only the synthesis knows such a name. */
    private static String generatedFieldType(Index index, CtType<?> type, String targetText) {
        if (targetText == null || !targetText.matches("[A-Za-z_$][\\w$]*")) return null;
        Lombok.Item field = index.generated().fields().get(Names.member(Names.qualified(type), targetText));
        return field == null ? null : field.typeFqn();
    }

    /**
     * A method reference (`Cookie::getValue`, `cookie::getValue`) as a call row: the same receiver type and target as a
     * call would have, with `via: methodRef` and the referenced method's arity. It has no arguments of its own.
     */
    private static void methodRefRow(JsonGenerator g, Ctx ctx, CtType<?> type, String methodId,
            CtExecutableReferenceExpression<?, ?> expression, Positions.Pos pos) throws IOException {
        CtExecutableReference<?> ref = expression.getExecutable();
        String name = ref == null ? null : ref.getSimpleName();
        // The referenced method's arity is the reference's own: a library method has no declaration to count.
        Integer argc = ref == null ? null : ref.getParameters().size();
        CtExpression<?> target = expression.getTarget();
        String receiver = target == null ? null : ctx.chains().receiver(target);
        if (receiver == null && ref != null && ref.getDeclaringType() != null)
            receiver = Names.nameOf(ref.getDeclaringType());
        if (receiver == null) receiver = Names.qualified(type);
        List<Target> targets = targets(ref, ctx.index(), receiver, name, argc == null ? 0 : argc);
        Recv recv = Recv.of(ctx, type, receiver, false);
        boolean unknownVar = varLocal(target);
        head(g, methodId, ctx.ids().id(expression), "methodRef", pos, name);
        g.writeStringField("via", "methodRef");
        writeArgc(g, argc);
        writeRecv(g, recv.invented() ? null : recv.type(), ctx, target,
                ref != null && ref.isStatic() ? "static" : "instance", target == null ? "static" : how(target),
                ctx.refs().textOf(expression));
        writeTargets(g, targets);
        g.writeBooleanField("uniqueImpl", uniqueImpl(ref, targets));
        writeArgs(g, ctx, List.of());
        inLambda(g, expression);
        g.writeStringField("origin", !targets.isEmpty() ? "java"
                : recv.declared() || unknownVar || recv.invented() ? "unresolved" : "library");
        if (targets.isEmpty())
            g.writeStringField("reason", recv.invented() ? "unresolved-name"
                    : recv.declared() ? "no-declaration-here" : unknownVar ? "var-unresolved" : "library-signature");
    }

    /**
     * A `new` as a call row: the constructor it reaches (`Foo#Foo(String)`), with the created type as its receiver. A
     * constructor is not overridden, so its targets are the declaration alone.
     */
    private static void ctorRow(JsonGenerator g, Ctx ctx, CtType<?> type, String methodId, CtConstructorCall<?> call,
            Positions.Pos pos) throws IOException {
        CtExecutableReference<?> ref = call.getExecutable();
        String name = ref == null ? "<init>" : ref.getSimpleName();
        int argc = call.getArguments().size();
        String receiver = ref == null || ref.getDeclaringType() == null ? null
                : Names.nameOf(ref.getDeclaringType());
        Lombok.Item made = lombokConstructor(ctx.index(), ref, receiver, argc);
        List<Target> targets = made != null ? List.of(new Target(made.id(), "declared"))
                : targets(ref, ctx.index(), receiver, name, argc);
        Recv recv = Recv.of(ctx, type, receiver, false);
        head(g, methodId, ctx.ids().id(call), "new", pos, name);
        g.writeNumberField("argc", argc);
        writeRecv(g, recv.invented() ? null : recv.type(), ctx, null, "instance", "new", ctx.refs().textOf(call));
        writeTargets(g, targets);
        g.writeBooleanField("uniqueImpl", false);
        writeArgs(g, ctx, call.getArguments());
        inLambda(g, call);
        g.writeStringField("origin", made != null ? "lombok" : !targets.isEmpty() ? "java"
                : recv.declared() || recv.invented() ? "unresolved" : "library");
        if (targets.isEmpty())
            g.writeStringField("reason", recv.invented() ? "unresolved-name"
                    : recv.declared() ? "no-declaration-here" : "library-signature");
    }

    /**
     * The Lombok constructor a `new` reaches: the one of its arity, unless the program writes a constructor the call
     * matches (Spoon has that declaration). Null when Lombok writes no constructor of that arity.
     */
    private static Lombok.Item lombokConstructor(Index index, CtExecutableReference<?> ref, String owner, int argc) {
        if (owner == null || (ref != null && ref.getDeclaration() instanceof CtConstructor<?> c && !c.isImplicit()))
            return null;
        return index.generated().constructor(owner, argc);
    }

    /**
     * A site Spoon refused to type: the row every call row has, with each unknown value null and no target, and with
     * `origin: error` and the reason. Never silently dropped, never guessed. Package-private so a test can write one.
     */
    static void errorRow(JsonGenerator g, String methodId, String id, CtElement site, Positions.Pos pos,
            RuntimeException e, Failures failures) throws IOException {
        String kind = site instanceof CtExecutableReferenceExpression<?, ?> ? "methodRef"
                : site instanceof CtConstructorCall<?> ? "new" : "call";
        String name = null;
        try {
            CtExecutableReference<?> ref = site instanceof CtInvocation<?> call ? call.getExecutable()
                    : site instanceof CtExecutableReferenceExpression<?, ?> expression ? expression.getExecutable()
                    : null;
            name = ref == null ? null : ref.getSimpleName();
        } catch (RuntimeException ignored) {
            // The name is worth having but not worth failing for: the row keeps null, and the run says so.
            failures.count("sites.nameUnresolved");
        }
        if (site instanceof CtConstructorCall<?>) name = "<init>";
        head(g, methodId, id, kind, pos, name);
        if (site instanceof CtExecutableReferenceExpression<?, ?>) g.writeStringField("via", "methodRef");
        writeArgc(g, site instanceof CtInvocation<?> call ? call.getArguments().size()
                : site instanceof CtConstructorCall<?> created ? created.getArguments().size() : null);
        writeRecv(g, null, null, null, null, null, null);
        writeTargets(g, List.of());
        g.writeBooleanField("uniqueImpl", false);
        g.writeArrayFieldStart("args");
        g.writeEndArray();
        inLambda(g, site);
        g.writeStringField("origin", "error");
        g.writeStringField("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
    }

    /** The fields every site row starts with, in the order the call and method-reference rows write them. */
    private static void head(JsonGenerator g, String methodId, String id, String kind, Positions.Pos pos, String name)
            throws IOException {
        g.writeStringField("method", methodId);
        if (id == null) g.writeNullField("id");
        else g.writeStringField("id", id);
        g.writeStringField("file", pos.file());
        g.writeNumberField("line", pos.line());
        g.writeNumberField("col", pos.col());
        g.writeStringField("kind", kind);
        if (name == null) g.writeNullField("name");
        else g.writeStringField("name", name);
    }

    /** The number of arguments as written, or null when the site could not say how many it has. */
    private static void writeArgc(JsonGenerator g, Integer argc) throws IOException {
        if (argc == null) g.writeNullField("argc");
        else g.writeNumberField("argc", argc);
    }

    /**
     * The receiver object: its type as a join key (null when judged invented or unknown), its type arguments as the site
     * writes them, how it is reached, and the text it is written as, which is how a reader names the site. All null and
     * empty for a site that could not be typed.
     */
    private static void writeRecv(JsonGenerator g, String type, Ctx ctx, CtExpression<?> target, String kind,
            String how, String text) throws IOException {
        g.writeObjectFieldStart("recv");
        if (type == null) g.writeNullField("typeFqn");
        else g.writeStringField("typeFqn", type);
        g.writeArrayFieldStart("typeArgs");
        if (ctx != null) for (String arg : ctx.refs().typeArgs(target == null ? null : target.getType(), target))
            g.writeString(arg);
        g.writeEndArray();
        if (kind == null) g.writeNullField("kind");
        else g.writeStringField("kind", kind);
        if (how == null) g.writeNullField("how");
        else g.writeStringField("how", how);
        if (text == null) g.writeNullField("text");
        else g.writeStringField("text", text);
        g.writeEndObject();
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

    /** Every argument, as data: `text` is for display, `kind` and its fields are the fact. */
    private static void writeArgs(JsonGenerator g, Ctx ctx, List<CtExpression<?>> args) throws IOException {
        g.writeArrayFieldStart("args");
        for (CtExpression<?> argument : args) {
            g.writeStartObject();
            Refs.write(g, ctx.refs().of(argument));
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    /** Every site says whether it sits inside a lambda, where it may run later or never. */
    private static void inLambda(JsonGenerator g, CtElement site) throws IOException {
        g.writeBooleanField("inLambda", site.getParent(CtLambda.class) != null);
    }

    private static String callOrigin(Ctx ctx, List<Target> targets, Lombok.Item generated,
            CtExecutableReference<?> ref, Recv recv) {
        if (!targets.isEmpty()) {
            if (generated != null) return generated.origin();
            return declaredIn(ctx, ref) ? "java" : "arity";
        }
        if (recv.builder()) return "lombok";
        if (recv.invented()) return "unresolved";
        if (recv.generatedField() || libraryTarget(ctx, ref)) return "library";
        return recv.type() == null || recv.declared() ? "unresolved" : "library";
    }

    private static String callReason(Recv recv, CtExpression<?> target) {
        if (recv.builder()) return "lombok-builder";
        if (recv.invented()) return "unresolved-name";
        if (recv.type() == null) return varLocal(target) ? "var-unresolved" : "no-callee";
        return recv.declared() ? "no-declaration-here" : "library-signature";
    }

    /** True when a call's resolved declaration belongs to a type declared in this checkout: Spoon answered. */
    private static boolean declaredIn(Ctx ctx, CtExecutableReference<?> ref) {
        CtMethod<?> method = declaration(ref);
        return method != null && method.getDeclaringType() != null
                && ctx.index().declared().contains(Names.qualified(method.getDeclaringType()));
    }

    /** True when a call's resolved declaration is a library's, or has no declaring type at all. */
    private static boolean libraryTarget(Ctx ctx, CtExecutableReference<?> ref) {
        CtMethod<?> method = declaration(ref);
        return method != null && (method.getDeclaringType() == null
                || !ctx.index().declared().contains(Names.qualified(method.getDeclaringType())));
    }

    private static CtMethod<?> declaration(CtExecutableReference<?> ref) {
        return ref != null && ref.getDeclaration() instanceof CtMethod<?> method ? method : null;
    }

    /** True when a receiver is a `var` local: an unresolved one is an unknown, not a missing callee. */
    private static boolean varLocal(CtExpression<?> target) {
        if (!(target instanceof CtVariableRead<?> read)) return false;
        var declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
        return declaration instanceof CtLocalVariable<?> local && local.isInferred();
    }

    /**
     * The declaration, then every implementation of it: a call through an interface reaches each subclass method with
     * the same name and arity, which is the graph a flow has to walk. The declaration is `declared`, each subtype
     * method `override`: which of the two a reader may follow is its policy, and this file only says which is which.
     */
    private static List<Target> targets(CtExecutableReference<?> ref, Index index, String receiver, String name,
            int argc) {
        List<Target> out = new ArrayList<>();
        if (ref == null) return out;
        if (ref.getDeclaration() instanceof CtConstructor<?> ctor) return constructorTargets(index, ctor, argc);
        if (!(ref.getDeclaration() instanceof CtMethod<?> method)) return byArity(index, receiver, name, argc);
        CtType<?> owner = method.getDeclaringType();
        if (owner == null || !index.declared().contains(Names.qualified(owner))) return out;
        // The method's own position can be synthetic (a record accessor); the owner's is the check that matters.
        if (owner.getPosition() == null || !owner.getPosition().isValidPosition()) return out;
        if (syntheticEnum(owner, method.getSimpleName())) return out;
        out.add(new Target(Names.executableId(owner, method), "declared"));
        boolean open = owner.isInterface() || owner.getModifiers().contains(ModifierKind.ABSTRACT);
        if (!open) return out;
        for (String subtype : index.subtypes().getOrDefault(Names.qualified(owner), Set.of()))
            addTarget(out, overrideIn(index, subtype, method), "override");
        return out;
    }

    /**
     * A constructor reached by `new` or by a constructor reference: its own declaration, the only one it can be. Spoon
     * invents a default constructor for a class that writes none, and that one answers only a call with no arguments,
     * and only where Lombok writes no constructor of the class. A record's canonical constructor is never implicit here.
     */
    private static List<Target> constructorTargets(Index index, CtConstructor<?> ctor, int argc) {
        CtType<?> owner = ctor.getDeclaringType();
        if (owner == null || !index.declared().contains(Names.qualified(owner))) return List.of();
        if (owner.getPosition() == null || !owner.getPosition().isValidPosition()) return List.of();
        boolean invented = ctor.isImplicit() && !(owner instanceof CtRecord);
        if (invented && (argc != 0 || index.generated().constructed(Names.qualified(owner)))) return List.of();
        return List.of(new Target(Names.executableId(owner, ctor), "declared"));
    }

    /**
     * The member of a subtype that overrides `method`, by Spoon's own signature check (so `take(Integer)` is not the
     * override of `take(String)`). A record's accessor is written by the record, not declared, and answers to its
     * component's name with no argument.
     */
    private static String overrideIn(Index index, String subtype, CtMethod<?> method) {
        CtType<?> sub = index.types().get(subtype);
        if (sub == null) return null;
        for (CtMethod<?> candidate : sub.getMethods())
            if (candidate.getSimpleName().equals(method.getSimpleName()) && candidate.isOverriding(method))
                return Names.executableId(sub, candidate);
        String shape = Names.shape(method.getSimpleName(), method.getParameters().size());
        return sub instanceof CtRecord ? index.byShape().getOrDefault(subtype, Map.of()).get(shape) : null;
    }

    /**
     * A call Spoon refuses to pick an overload for. Inside a project type, name and arity are still a fact when they
     * leave exactly one member, marked by origin and never dressed up as a compiler answer. The call may sit on an
     * inherited member: the nearest declaration wins, one level at a time.
     */
    private static List<Target> byArity(Index index, String receiver, String name, int argc) {
        List<Target> out = new ArrayList<>();
        if (receiver == null || !index.declared().contains(receiver)) return out;
        List<String> level = List.of(receiver);
        Set<String> seen = new HashSet<>();
        while (!level.isEmpty() && out.isEmpty()) {
            List<String> next = new ArrayList<>();
            for (String owner : level) {
                if (!seen.add(owner)) continue;
                addTarget(out, index.byArity().getOrDefault(owner, Map.of()).get(Names.shape(name, argc)), "declared");
                next.addAll(index.supertypes().getOrDefault(owner, Set.of()));
            }
            level = next;
        }
        return out;
    }

    private static void addTarget(List<Target> out, String id, String kind) {
        if (id != null && out.stream().noneMatch(t -> t.id().equals(id))) out.add(new Target(id, kind));
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

    /** `values()`/`valueOf(String)` on an enum are compiler-written: never a member, never a target. */
    private static boolean syntheticEnum(CtType<?> owner, String name) {
        return owner.isEnum() && ("values".equals(name) || "valueOf".equals(name));
    }

    /**
     * How the receiver was reached, in the vocabulary the facts already speak: a field, a parameter, a local, a chain, a
     * static type, `super`, `this`, or nothing written at all (implicit).
     */
    private static String how(CtExpression<?> target) {
        if (target == null) return "implicit";
        if (target instanceof CtTypeAccess<?>) return "static";
        if (target instanceof CtSuperAccess<?>) return "super";
        if (target instanceof CtThisAccess<?>) return "this";
        if (target instanceof CtInvocation<?>) return "chain";
        if (target instanceof CtVariableRead<?> read) {
            var declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
            if (declaration instanceof spoon.reflect.declaration.CtField<?>) return "field";
            if (declaration instanceof spoon.reflect.declaration.CtParameter<?> parameter)
                // A lambda's parameter is a parameter to Spoon; the facts distinguish it, so the dump does too.
                return parameter.getParent() instanceof CtLambda<?> ? "lambda" : "param";
            return "local";
        }
        return "expr";
    }

    private static String kind(CtInvocation<?> call) {
        CtExecutableReference<?> ref = call.getExecutable();
        if (call.getTarget() == null) return ref != null && ref.isStatic() ? "static" : "implicit";
        if (call.getTarget() instanceof CtSuperAccess<?>) return "super";
        if (call.getTarget() instanceof CtTypeAccess<?>) return "static";
        return "instance";
    }
}
