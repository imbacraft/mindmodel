package mindmodel.engine.write;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtExecutableReference;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Names;
import mindmodel.engine.model.Positions;
import mindmodel.engine.model.Walk;
import mindmodel.engine.resolve.CallIds;
import mindmodel.engine.resolve.Calls;
import mindmodel.engine.resolve.Calls.Recv;
import mindmodel.engine.resolve.Calls.Target;
import mindmodel.engine.resolve.Chains;
import mindmodel.engine.resolve.FieldAccess;
import mindmodel.engine.resolve.Lombok;
import mindmodel.engine.resolve.Refs;
import mindmodel.engine.resolve.Returns;

/**
 * calls.ndjson: every call site and method reference inside a dumped type's body, with the receiver's static type and
 * the declarations it reaches. Anonymous and local class bodies sit inside their enclosing method's span, so their
 * calls belong to it. Each row carries an {@code id}, which an argument that is a call names, so the argument graph is
 * a lookup.
 *
 * <p>The bodies are read once here, and what they hand the other sections (each body's returns, every field access) is
 * returned for those writers.
 */
public final class CallsWriter {

    /** What the bodies hand the other sections: each body's returns, and every field access. */
    public record Written(Map<CtExecutable<?>, List<Returns.Entry>> returns, List<FieldAccess.Row> fields) {
    }

    /** What every site row is written with: the resolver, the readers and sinks, and the returns and fields so far. */
    private record Ctx(Calls calls, Chains chains, CallIds ids, Refs refs, Positions positions,
                       Map<CtExecutable<?>, List<Returns.Entry>> returns, List<FieldAccess.Row> fields,
                       FieldAccess.Known statics) {
    }

    /** A site with the position it was read at, so the position is computed once. */
    private record Site(CtElement element, Positions.Pos pos) {
    }

    private CallsWriter() {
    }

    /**
     * Writes calls.ndjson. {@code known} adds the generated sources' signatures, which the resolver needs so a call
     * into a generated mapper is typed like any other; they are never walked.
     */
    public static Written write(List<CtType<?>> types, List<CtType<?>> known, Lombok.Index generated,
            Walk.Bodies bodies, Positions positions, CallIds ids, Refs refs, Path out) throws IOException {
        Chains chains = new Chains(generated, refs.failures());
        Ctx ctx = new Ctx(new Calls(known, generated, chains, refs.failures()), chains, ids, refs, positions,
                new IdentityHashMap<>(), new ArrayList<>(), FieldAccess.Known.of(known, generated));
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

    /**
     * One body's rows and what it hands the other sections. {@code ownSites} is false for an anonymous class's method,
     * whose calls and field accesses the enclosing member's body already holds.
     */
    private static void writeBody(Ndjson w, Ctx ctx, CtType<?> type, CtExecutable<?> executable, String methodId,
            Walk.Body body, boolean ownSites) throws IOException {
        // The body's own writes first: a returned local can still name the value it was assigned.
        ctx.refs().scope(body.writes());
        if (ownSites) writeSites(w, ctx, type, methodId, body.sites());
        ctx.returns().put(executable, Returns.plan(executable, body, ctx.refs()));
        if (ownSites) FieldAccess.collect(ctx.fields(), body, methodId, ctx.positions(), ctx.refs(), ctx.statics());
    }

    /**
     * A type's field initialisers and initializer blocks, owned by a pseudo-member: {@code <clinit>()} for the static
     * ones and {@code <init>()} for the ones that run per instance. Their sites are rows like any other.
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
            // One element Spoon cannot type must not end a large dump: name it, keep going.
            w.row(g -> errorRow(g, methodId, ctx.ids().id(site.element()), site.element(), site.pos(), e,
                    ctx.refs().failures()));
        }
    }

    /** One call site: its receiver, what it resolves to, and its arguments. */
    private static void callRow(JsonGenerator g, Ctx ctx, CtType<?> type, String methodId, CtInvocation<?> call,
            Positions.Pos pos) throws IOException {
        Calls calls = ctx.calls();
        CtExecutableReference<?> ref = call.getExecutable();
        String name = ref == null ? null : ref.getSimpleName();
        int argc = call.getArguments().size();
        String targetText = ctx.refs().textOf(call.getTarget());
        String fieldType = calls.generatedFieldType(type, targetText);
        // A name no declaration gives has no receiver and no target: the executable's own declaration names the class
        // the call is written in, which is not what the call reaches.
        boolean unnamed = fieldType == null && calls.undeclared(call.getTarget());
        String receiver = unnamed ? null : calls.receiverOf(type, call, fieldType);
        List<Target> targets = unnamed ? List.of() : calls.targets(ref, receiver, name, argc);
        Lombok.Item item = null;
        if (!unnamed && targets.isEmpty() && ref != null) {
            // Unqualified call: its receiver is the class being written, so a generated sibling is the target.
            String owner = receiver != null ? receiver : Names.qualified(type);
            item = calls.generated().method(owner, name, argc);
            if (item != null) {
                targets = List.of(new Target(item.id(), "declared"));
                receiver = owner;
            }
        }
        Recv recv = calls.recv(type, receiver, fieldType != null, unnamed);
        boolean inherited = targets.isEmpty() && calls.inheritedFromEnum(recv, name, argc);
        head(g, methodId, ctx.ids().id(call), "call", pos, name);
        g.writeNumberField("argc", argc);
        writeRecv(g, recv.invented() ? null : recv.type(), ctx, call.getTarget(), Calls.kind(call),
                Calls.how(call.getTarget()), targetText);
        writeTargets(g, targets);
        g.writeBooleanField("uniqueImpl", Calls.uniqueImpl(ref, targets));
        writeArgs(g, ctx, call.getArguments());
        inLambda(g, call);
        g.writeStringField("origin", callOrigin(calls, targets, item, ref, recv, inherited));
        if (targets.isEmpty()) g.writeStringField("reason", inherited ? "library-signature"
                : callReason(recv, call.getTarget()));
    }

    /**
     * A method reference (`Cookie::getValue`, `cookie::getValue`) as a call row: the same receiver and targets a call
     * would have, with {@code via: methodRef} and the referenced method's arity. It has no arguments of its own.
     */
    private static void methodRefRow(JsonGenerator g, Ctx ctx, CtType<?> type, String methodId,
            CtExecutableReferenceExpression<?, ?> expression, Positions.Pos pos) throws IOException {
        Calls calls = ctx.calls();
        CtExecutableReference<?> ref = expression.getExecutable();
        String name = ref == null ? null : ref.getSimpleName();
        // The referenced method's arity is the reference's own: a library method has no declaration to count.
        Integer argc = ref == null ? null : ref.getParameters().size();
        CtExpression<?> target = expression.getTarget();
        boolean unnamed = calls.undeclared(target);
        String receiver = unnamed ? null : calls.methodRefReceiver(type, ref, target);
        List<Target> targets = unnamed ? List.of() : calls.targets(ref, receiver, name, argc == null ? 0 : argc);
        Recv recv = calls.recv(type, receiver, false, unnamed);
        boolean unknownVar = Calls.varLocal(target);
        head(g, methodId, ctx.ids().id(expression), "methodRef", pos, name);
        g.writeStringField("via", "methodRef");
        writeArgc(g, argc);
        writeRecv(g, recv.invented() ? null : recv.type(), ctx, target,
                ref != null && ref.isStatic() ? "static" : "instance", target == null ? "static" : Calls.how(target),
                ctx.refs().textOf(expression));
        writeTargets(g, targets);
        g.writeBooleanField("uniqueImpl", Calls.uniqueImpl(ref, targets));
        writeArgs(g, ctx, List.of());
        inLambda(g, expression);
        g.writeStringField("origin", !targets.isEmpty() ? "java"
                : recv.declared() || unknownVar || recv.invented() ? "unresolved" : "library");
        if (targets.isEmpty())
            g.writeStringField("reason", recv.invented() ? "unresolved-name"
                    : recv.declared() ? "no-declaration-here" : unknownVar ? "var-unresolved" : "library-signature");
    }

    /**
     * A {@code new} as a call row: the constructor it reaches (`Foo#Foo(String)`), with the created type as its
     * receiver. A constructor is not overridden, so its targets are the declaration alone.
     */
    private static void ctorRow(JsonGenerator g, Ctx ctx, CtType<?> type, String methodId, CtConstructorCall<?> call,
            Positions.Pos pos) throws IOException {
        Calls calls = ctx.calls();
        CtExecutableReference<?> ref = call.getExecutable();
        String name = ref == null ? "<init>" : ref.getSimpleName();
        int argc = call.getArguments().size();
        String receiver = ref == null || ref.getDeclaringType() == null ? null
                : Names.nameOf(ref.getDeclaringType());
        Lombok.Item made = calls.lombokConstructor(ref, receiver, argc);
        List<Target> targets = made != null ? List.of(new Target(made.id(), "declared"))
                : calls.targets(ref, receiver, name, argc);
        Recv recv = calls.recv(type, receiver, false, false);
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
     * A site Spoon refused to type: the row every call row has, with each unknown value null and no target, and with
     * {@code origin: error} and the reason. Never silently dropped, never guessed.
     */
    public static void errorRow(JsonGenerator g, String methodId, String id, CtElement site, Positions.Pos pos,
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
            failures.count(Failures.Key.NAME_UNRESOLVED);
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
        g.writeStringField("reason", Failures.reason(e));
    }

    /** The fields every site row starts with, in the order the call and method-reference rows write them. */
    private static void head(JsonGenerator g, String methodId, String id, String kind, Positions.Pos pos, String name)
            throws IOException {
        g.writeStringField("method", methodId);
        Json.key(g, "id", id);
        g.writeStringField("file", pos.file());
        g.writeNumberField("line", pos.line());
        g.writeNumberField("col", pos.col());
        g.writeStringField("kind", kind);
        Json.key(g, "name", name);
    }

    /** The number of arguments as written, or null when the site could not say how many it has. */
    private static void writeArgc(JsonGenerator g, Integer argc) throws IOException {
        if (argc == null) g.writeNullField("argc");
        else g.writeNumberField("argc", argc);
    }

    /**
     * The receiver object: its type as a join key (null when judged invented or unknown), its type arguments as the
     * site writes them, how it is reached, and the text it is written as, which is how a reader names the site. All
     * null and empty for a site that could not be typed.
     */
    private static void writeRecv(JsonGenerator g, String type, Ctx ctx, CtExpression<?> target, String kind,
            String how, String text) throws IOException {
        g.writeObjectFieldStart("recv");
        Json.key(g, "typeFqn", type);
        g.writeArrayFieldStart("typeArgs");
        if (ctx != null) for (String arg : ctx.refs().typeArgs(target == null ? null : target.getType(), target))
            g.writeString(arg);
        g.writeEndArray();
        Json.key(g, "kind", kind);
        Json.key(g, "how", how);
        Json.key(g, "text", text);
        g.writeEndObject();
    }

    /** {@code targets}: the declaration and each override of it, in that order, each with which of the two it is. */
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

    /** Every argument, as data: {@code text} is for display, {@code kind} and its fields are the fact. */
    private static void writeArgs(JsonGenerator g, Ctx ctx, List<CtExpression<?>> args) throws IOException {
        g.writeArrayFieldStart("args");
        for (CtExpression<?> argument : args) {
            g.writeStartObject();
            Json.ref(g, ctx.refs().of(argument));
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    /** Every site says whether it sits inside a lambda, where it may run later or never. */
    private static void inLambda(JsonGenerator g, CtElement site) throws IOException {
        g.writeBooleanField("inLambda", site.getParent(CtLambda.class) != null);
    }

    private static String callOrigin(Calls calls, List<Target> targets, Lombok.Item generated,
            CtExecutableReference<?> ref, Recv recv, boolean inherited) {
        if (!targets.isEmpty()) {
            if (generated != null) return generated.origin();
            return calls.declaredIn(ref) ? "java" : "arity";
        }
        if (recv.builder()) return "lombok";
        if (inherited) return "library";
        if (recv.invented()) return "unresolved";
        if (recv.generatedField() || calls.libraryTarget(ref)) return "library";
        return recv.type() == null || recv.declared() ? "unresolved" : "library";
    }

    private static String callReason(Recv recv, CtExpression<?> target) {
        if (recv.builder()) return "lombok-builder";
        if (recv.invented()) return "unresolved-name";
        if (recv.type() == null) return Calls.varLocal(target) ? "var-unresolved" : "no-callee";
        return recv.declared() ? "no-declaration-here" : "library-signature";
    }
}
