package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtIf;
import spoon.reflect.code.CtLoop;
import spoon.reflect.code.CtNewArray;
import spoon.reflect.code.CtStatement;
import spoon.reflect.code.CtTry;
import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtCatch;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtEnum;
import spoon.reflect.declaration.CtEnumValue;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtModifiable;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtRecordComponent;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeMember;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtTypeReference;

/**
 * members.ndjson: fields, methods, constructors, enum constants and record components. A generated member (Lombok) is
 * added by the synthesis pass with {@code generated: "lombok"}, positioned at the annotated declaration.
 */
public final class Members {

    /** One decision arm of a body: the lines its statement(s) occupy, and which decision put them there. */
    private record Arm(int start, int end, String kind) {
    }

    /** One `try` in a body: the lines of its block and, when it has one, of its finalizer. */
    private record TryRange(int start, int end, int finallyStart, int finallyEnd) {
    }

    /** What every row reads: the run's bodies, positions, returns and failure counts. */
    private record Ctx(Walk.Bodies bodies, Positions positions, Map<CtExecutable<?>, List<Returns.Entry>> returns,
                       Failures failures) {
    }

    private Members() {
    }

    public static void write(List<CtType<?>> types, Map<String, List<Lombok.Item>> synth, Walk.Bodies bodies,
            Positions positions, Path out, Map<CtExecutable<?>, List<Returns.Entry>> returns, Failures failures)
            throws IOException {
        Ctx ctx = new Ctx(bodies, positions, returns, failures);
        try (Ndjson w = new Ndjson(out)) {
            for (CtType<?> t : types) writeType(w, t, synth.getOrDefault(Names.qualified(t), List.of()), ctx);
        }
    }

    /** One type's rows, in the order the section has always written them. */
    private static void writeType(Ndjson w, CtType<?> t, List<Lombok.Item> generated, Ctx ctx) throws IOException {
        // Methods of anonymous and local classes written in a member's body: the type's own body work.
        for (Walk.Anon anon : ctx.bodies().anonymous(t)) w.row(g -> anonymous(g, t, anon, ctx));
        if (t instanceof CtEnum<?> e)
            for (CtEnumValue<?> value : e.getEnumValues()) w.row(g -> enumConstant(g, t, value, ctx));
        for (CtTypeMember member : t.getTypeMembers()) writeMember(w, t, member, ctx);
        Set<String> declaredIds = declaredIds(t);
        // An explicit member wins over a generated one.
        for (Lombok.Item item : generated) if (!declaredIds.contains(item.id())) w.row(g -> synthRow(g, item));
        if (t instanceof CtRecord record) writeRecord(w, record, ctx);
    }

    private static void writeMember(Ndjson w, CtType<?> t, CtTypeMember member, Ctx ctx) throws IOException {
        // Enum constants are written with the enum's own rows; Spoon also lists them as fields, which they are not.
        if (member instanceof CtEnumValue<?>) return;
        if (member instanceof CtField<?> field) {
            w.row(g -> field(g, t, field, ctx));
        } else if (member instanceof CtConstructor<?> ctor) {
            // A record's canonical constructor is written from its components: Spoon 11.5 hands it back in another
            // order, and leaves it out entirely for a nested record.
            if (t instanceof CtRecord record && RecordCtors.isCanonical(record, ctor)) return;
            w.row(g -> executable(g, t, ctor, Names.executableId(t, ctor), false, ctx));
        } else if (member instanceof CtMethod<?> method && !compilerWritten(t, method)) {
            w.row(g -> executable(g, t, method, Names.executableId(t, method), false, ctx));
        }
    }

    /**
     * A method the compiler wrote, not the author: a record accessor Spoon lists without a position (the component pass
     * writes it), and the `values()` and `valueOf` of an enum. Such a method has no source position.
     */
    private static boolean compilerWritten(CtType<?> t, CtMethod<?> method) {
        if (method.getPosition() != null && method.getPosition().isValidPosition()) return false;
        String name = method.getSimpleName();
        if (t instanceof CtRecord record && method.getParameters().isEmpty()
                && record.getRecordComponents().stream().anyMatch(c -> c.getSimpleName().equals(name))) return true;
        return t.isEnum() && ("values".equals(name) || "valueOf".equals(name));
    }

    private static Set<String> declaredIds(CtType<?> t) {
        Set<String> ids = new HashSet<>();
        for (CtTypeMember member : t.getTypeMembers())
            if (member instanceof CtMethod<?> method) ids.add(Names.executableId(t, method));
        return ids;
    }

    private static void writeRecord(Ndjson w, CtRecord record, Ctx ctx) throws IOException {
        w.row(g -> recordConstructor(g, record, ctx));
        for (CtRecordComponent component : record.getRecordComponents()) {
            w.row(g -> recordComponent(g, record, component, ctx));
            // The accessor is generated by the compiler but real to every caller, so it is a member with a position:
            // the component's own line. Spoon may already expose it, with a body the author wrote: nothing to add then.
            boolean authored = record.getMethods().stream()
                    .anyMatch(m -> m.getSimpleName().equals(component.getSimpleName())
                            && m.getParameters().isEmpty()
                            && m.getPosition() != null && m.getPosition().isValidPosition());
            if (!authored) w.row(g -> recordAccessor(g, record, component, ctx));
        }
    }

    private static void field(JsonGenerator g, CtType<?> owner, CtField<?> f, Ctx ctx) throws IOException {
        g.writeStringField("kind", "field");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", f.getSimpleName());
        g.writeStringField("type", Names.typeText(f.getType()));
        // The type as the compiler names it: a declaration's field type is a fact, not something Node resolves. A type
        // Spoon invented has no name here: the written name stays in `type`, and the run counts it.
        g.writeStringField("typeFqn", Refs.joinKey(f.getType(), f, ctx.failures()));
        Ndjson.modifiers(g, f.getModifiers());
        Anns.write(g, f.getAnnotations());
        Ndjson.pos(g, ctx.positions().of(f));
        writeConstant(g, f);
    }

    private static void enumConstant(JsonGenerator g, CtType<?> owner, CtEnumValue<?> v, Ctx ctx) throws IOException {
        g.writeStringField("kind", "enumConstant");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", v.getSimpleName());
        Anns.write(g, v.getAnnotations());
        Ndjson.pos(g, ctx.positions().of(v));
        g.writeArrayFieldStart("args");
        List<CtExpression<?>> args = new ArrayList<>();
        CtExpression<?> init = v.getDefaultExpression();
        if (init instanceof CtNewArray<?> array) args.addAll(array.getElements());
        else if (init instanceof CtConstructorCall<?> call) args.addAll(call.getArguments());
        for (CtExpression<?> element : args) Anns.writeValue(g, Values.orUnresolved(element));
        g.writeEndArray();
    }

    /**
     * One constructor or method: its signature, modifiers, body facts and position. An anonymous method is the same row
     * with its line-suffixed id and `anonymous: true`.
     */
    private static void executable(JsonGenerator g, CtType<?> owner, CtExecutable<?> e, String id, boolean anonymous,
            Ctx ctx) throws IOException {
        boolean constructor = e instanceof CtConstructor<?>;
        g.writeStringField("kind", constructor ? "constructor" : "method");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", constructor ? owner.getSimpleName() : e.getSimpleName());
        params(g, e.getParameters());
        g.writeStringField("id", id);
        if (e instanceof CtMethod<?> method) {
            g.writeStringField("returns", Names.typeText(method.getType()));
            // An entry point is a shape of the code, not a conclusion: `public static void main(String[])`.
            if (!anonymous) g.writeBooleanField("isMain", isMain(method));
        }
        Ndjson.modifiers(g, ((CtModifiable) e).getModifiers());
        g.writeBooleanField("hasBody", e.getBody() != null);
        if (anonymous) g.writeBooleanField("anonymous", true);
        throwsOf(g, e.getThrownTypes());
        Anns.write(g, e.getAnnotations());
        body(g, e, ctx);
        Ndjson.pos(g, ctx.positions().of(e));
    }

    private static void anonymous(JsonGenerator g, CtType<?> owner, Walk.Anon anon, Ctx ctx) throws IOException {
        executable(g, owner, anon.method(), anon.id(), true, ctx);
    }

    /**
     * The canonical constructor: its parameters are the record components in declaration order, its line is the compact
     * constructor when one is written and the record header otherwise. Calls to it resolve to this id.
     */
    private static void recordConstructor(JsonGenerator g, CtRecord owner, Ctx ctx) throws IOException {
        CtConstructor<?> ctor = RecordCtors.canonical(owner);
        g.writeStringField("kind", "constructor");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", owner.getSimpleName());
        g.writeArrayFieldStart("params");
        for (CtRecordComponent component : RecordCtors.components(owner)) {
            g.writeStartObject();
            g.writeStringField("type", Names.typeText(component.getType()));
            g.writeStringField("name", component.getSimpleName());
            g.writeBooleanField("varargs", false);
            Anns.write(g, component.getAnnotations());
            g.writeEndObject();
        }
        g.writeEndArray();
        g.writeStringField("id", RecordCtors.id(owner));
        Ndjson.modifiers(g, RecordCtors.modifiers(owner, ctor));
        g.writeBooleanField("hasBody", ctor == null || ctor.getBody() != null);
        Collection<? extends CtTypeReference<?>> thrown = ctor == null ? List.of() : ctor.getThrownTypes();
        throwsOf(g, thrown);
        Anns.write(g, ctor == null ? List.of() : ctor.getAnnotations());
        body(g, ctor, ctx);
        Ndjson.pos(g, RecordCtors.citation(owner, ctor, ctx.positions()));
    }

    private static void recordComponent(JsonGenerator g, CtRecord owner, CtRecordComponent c, Ctx ctx)
            throws IOException {
        g.writeStringField("kind", "recordComponent");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", c.getSimpleName());
        g.writeStringField("type", Names.typeText(c.getType()));
        Anns.write(g, c.getAnnotations());
        Ndjson.pos(g, ctx.positions().of(c));
    }

    private static void recordAccessor(JsonGenerator g, CtRecord owner, CtRecordComponent c, Ctx ctx)
            throws IOException {
        g.writeStringField("kind", "method");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", c.getSimpleName());
        g.writeArrayFieldStart("params");
        g.writeEndArray();
        g.writeStringField("id", Names.methodId(owner, c.getSimpleName(), List.of()));
        g.writeStringField("returns", Names.typeText(c.getType()));
        g.writeArrayFieldStart("modifiers");
        g.writeEndArray();
        g.writeBooleanField("hasBody", false);
        g.writeStringField("generated", "record");
        g.writeArrayFieldStart("throws");
        g.writeEndArray();
        g.writeArrayFieldStart("ann");
        g.writeEndArray();
        Ndjson.pos(g, ctx.positions().of(c));
    }

    /** A Lombok-generated member: same shape as a declared one, marked, positioned at the annotated element. */
    private static void synthRow(JsonGenerator g, Lombok.Item item) throws IOException {
        g.writeStringField("kind", item.kind());
        g.writeStringField("owner", item.owner());
        g.writeStringField("name", item.name());
        if (item.type() != null && !"method".equals(item.kind()) && !"constructor".equals(item.kind()))
            g.writeStringField("type", item.type());
        if ("method".equals(item.kind()) || "constructor".equals(item.kind())) {
            g.writeArrayFieldStart("params");
            for (String p : item.params()) {
                g.writeStartObject();
                g.writeStringField("type", p);
                g.writeEndObject();
            }
            g.writeEndArray();
            g.writeStringField("id", item.id());
            if (item.type() != null) g.writeStringField("returns", item.type());
        }
        Ndjson.modifiers(g, item.modifiers());
        g.writeBooleanField("hasBody", false);
        g.writeStringField("generated", "lombok");
        g.writeStringField("generatedBy", item.from());
        g.writeArrayFieldStart("throws");
        g.writeEndArray();
        g.writeArrayFieldStart("ann");
        g.writeEndArray();
        Ndjson.pos(g, item.pos());
    }

    private static void params(JsonGenerator g, List<CtParameter<?>> params) throws IOException {
        g.writeArrayFieldStart("params");
        for (CtParameter<?> p : params) {
            g.writeStartObject();
            g.writeStringField("type", Names.typeText(p.getType()));
            g.writeStringField("name", p.getSimpleName());
            g.writeBooleanField("varargs", p.isVarArgs());
            // Parameter annotations carry meaning too (@PathVariable, @RequestBody, a tenant id).
            Anns.write(g, p.getAnnotations());
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    private static void throwsOf(JsonGenerator g, Collection<? extends CtTypeReference<?>> thrown) throws IOException {
        g.writeArrayFieldStart("throws");
        for (CtTypeReference<?> t : thrown) g.writeString(Names.typeText(t));
        g.writeEndArray();
    }

    /** The body facts of one executable (none for a record without a canonical constructor): shape, then returns. */
    private static void body(JsonGenerator g, CtExecutable<?> e, Ctx ctx) throws IOException {
        Walk.Body body = e == null ? null : ctx.bodies().of(e);
        loops(g, body, ctx.positions());
        branches(g, body, ctx.positions());
        tryBlocks(g, body, ctx.positions());
        Returns.write(g, e == null ? null : ctx.returns().get(e));
    }

    /** The loops a body writes, as line ranges: a worker is a poll inside one, and Node must not re-read the body. */
    private static void loops(JsonGenerator g, Walk.Body body, Positions positions) throws IOException {
        g.writeArrayFieldStart("loops");
        if (body != null) {
            for (CtLoop loop : body.loops()) {
                Positions.Pos p = positions.of(loop);
                if (p == null) continue;
                g.writeStartObject();
                g.writeNumberField("start", p.line());
                g.writeNumberField("end", p.endLine());
                g.writeEndObject();
            }
        }
        g.writeEndArray();
    }

    /**
     * The decision arms a body writes, as line ranges: an if/else arm's body, a catch's body, a case's statements.
     * Never the condition — a call written in {@code if (repo.exists())} runs on the default path — so Node can say an
     * effect reached only through an arm is conditional without re-reading the body.
     */
    private static void branches(JsonGenerator g, Walk.Body body, Positions positions) throws IOException {
        List<Arm> arms = body == null ? List.of() : arms(body, positions);
        g.writeArrayFieldStart("branches");
        for (Arm a : arms) {
            g.writeStartObject();
            g.writeNumberField("start", a.start());
            g.writeNumberField("end", a.end());
            g.writeStringField("kind", a.kind());
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    private static List<Arm> arms(Walk.Body body, Positions positions) {
        List<Arm> arms = new ArrayList<>();
        for (CtIf iff : body.ifs()) {
            arm(arms, iff.getThenStatement(), "if", positions);
            CtStatement otherwise = iff.getElseStatement();
            // An else-if's arms are that nested if's own rows; the else itself has no body to range.
            if (otherwise != null && !(otherwise instanceof CtIf)) arm(arms, otherwise, "else", positions);
        }
        for (CtCatch c : body.catches()) arm(arms, c.getBody(), "catch", positions);
        // A case's statements, not the case: the label and its guard are the decision, not the arm.
        for (CtCase<?> c : body.cases())
            for (CtStatement s : c.getStatements()) arm(arms, s, "case", positions);
        // Source order, so the dump is byte-identical across runs and a reader can scan it.
        arms.sort(Comparator.comparingInt(Arm::start).thenComparingInt(Arm::end).thenComparing(Arm::kind));
        return arms;
    }

    private static void arm(List<Arm> arms, CtStatement statement, String kind, Positions positions) {
        Positions.Pos p = positions.of(statement);
        if (p != null) arms.add(new Arm(p.line(), p.endLine(), kind));
    }

    /**
     * The `try` blocks a body writes, as line ranges: the block, and its finalizer when it has one. A store whose
     * lifetime is one request is read off this shape — a call on one type inside the try and a call on the same type in
     * the finally — so the ranges are the dump's fact and no extractor re-reads a body. Never part of `branches`: a try
     * body always runs, so an effect written in it is not conditional.
     */
    private static void tryBlocks(JsonGenerator g, Walk.Body body, Positions positions) throws IOException {
        List<TryRange> blocks = body == null ? List.of() : tries(body, positions);
        g.writeArrayFieldStart("tryBlocks");
        for (TryRange b : blocks) {
            g.writeStartObject();
            g.writeNumberField("start", b.start());
            g.writeNumberField("end", b.end());
            if (b.finallyStart() > 0) {
                g.writeNumberField("finallyStart", b.finallyStart());
                g.writeNumberField("finallyEnd", b.finallyEnd());
            }
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    private static List<TryRange> tries(Walk.Body body, Positions positions) {
        List<TryRange> blocks = new ArrayList<>();
        for (CtTry t : body.tries()) {
            Positions.Pos block = positions.of(t.getBody());
            if (block == null) block = positions.of(t);
            if (block == null) continue;
            Positions.Pos fin = positions.of(t.getFinalizer());
            blocks.add(new TryRange(block.line(), block.endLine(),
                    fin == null ? 0 : fin.line(), fin == null ? 0 : fin.endLine()));
        }
        // Source order, so the dump is byte-identical across runs.
        blocks.sort(Comparator.comparingInt(TryRange::start).thenComparingInt(TryRange::end));
        return blocks;
    }

    /** `public static void main(String[])` — or its varargs spelling. Everything else is not an entry point. */
    private static boolean isMain(CtMethod<?> method) {
        if (!"main".equals(method.getSimpleName())) return false;
        Set<ModifierKind> modifiers = method.getModifiers();
        if (!modifiers.contains(ModifierKind.PUBLIC) || !modifiers.contains(ModifierKind.STATIC)) return false;
        CtTypeReference<?> type = method.getType();
        if (type == null || !"void".equals(type.getQualifiedName())) return false;
        if (method.getParameters().size() != 1) return false;
        CtTypeReference<?> parameter = method.getParameters().get(0).getType();
        if (!(parameter instanceof spoon.reflect.reference.CtArrayTypeReference<?> array)) return false;
        CtTypeReference<?> component = array.getComponentType();
        return component != null && "java.lang.String".equals(component.getQualifiedName());
    }

    private static void writeConstant(JsonGenerator g, CtField<?> field) throws IOException {
        if (!field.getModifiers().contains(ModifierKind.FINAL) || field.getDefaultExpression() == null) return;
        Values.Value value = Values.of(field.getDefaultExpression());
        if (value == null) return;
        g.writeFieldName("value");
        Anns.writeValue(g, value);
    }
}
