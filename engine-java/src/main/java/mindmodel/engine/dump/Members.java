package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtCatch;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtIf;
import spoon.reflect.code.CtNewArray;
import spoon.reflect.code.CtStatement;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtEnum;
import spoon.reflect.declaration.CtEnumValue;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
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

    private Members() {
    }

    public static void write(List<CtType<?>> types, java.util.Map<String, List<Lombok.Item>> synth, Path root,
            Path out) throws IOException {
        try (Ndjson w = new Ndjson(out)) {
            for (CtType<?> t : types) {
                java.util.Set<String> declaredIds = new java.util.HashSet<>();
                for (CtTypeMember member : t.getTypeMembers())
                    if (member instanceof CtMethod<?> m) declaredIds.add(Names.methodId(t, m.getSimpleName(), paramTypes(m)));
                // Methods of anonymous and local classes written in a member's body: the type's own body work.
                for (CtTypeMember member : t.getTypeMembers())
                    if (member instanceof CtExecutable<?> body)
                        for (CtMethod<?> inner : Anonymous.methods(body)) w.row(g -> anonymous(g, t, inner, root));
                Set<String> constants = new java.util.HashSet<>();
                if (t instanceof CtEnum<?> e) {
                    for (CtEnumValue<?> value : e.getEnumValues()) {
                        constants.add(value.getSimpleName());
                        w.row(g -> enumConstant(g, t, value, root));
                    }
                }
                for (CtTypeMember member : t.getTypeMembers()) {
                    if (member instanceof CtEnumValue<?> value && !constants.add(value.getSimpleName())) continue;
                    if (member instanceof CtEnumValue<?> value) w.row(g -> enumConstant(g, t, value, root));
                    else if (member instanceof CtField<?> field) w.row(g -> field(g, t, field, root));
                    else if (member instanceof CtConstructor<?> ctor) w.row(g -> callable(g, t, ctor, true, root));
                    else if (member instanceof CtMethod<?> method) {
                        // `values()` and `valueOf(String)` are written by the compiler, not by the author: they have no
                        // source position, and a dump of declarations must not claim them.
                        // A record accessor Spoon lists without a position is written once, by the component pass below.
                        if (t instanceof CtRecord record && method.getParameters().isEmpty()
                                && record.getRecordComponents().stream()
                                        .anyMatch(c -> c.getSimpleName().equals(method.getSimpleName()))
                                && (method.getPosition() == null || !method.getPosition().isValidPosition())) continue;
                        boolean syntheticEnum = t.isEnum()
                                && ("values".equals(method.getSimpleName()) || "valueOf".equals(method.getSimpleName()))
                                && (method.getPosition() == null || !method.getPosition().isValidPosition());
                        if (!syntheticEnum) w.row(g -> callable(g, t, method, false, root));
                    }
                }
                for (Lombok.Item item : synth.getOrDefault(Names.qualified(t), List.of())) {
                    if (declaredIds.contains(item.id())) continue; // an explicit member wins over a generated one
                    w.row(g -> synthRow(g, item));
                }
                if (t instanceof CtRecord record) {
                    Set<CtRecordComponent> components = record.getRecordComponents();
                    for (CtRecordComponent component : components) {
                        w.row(g -> recordComponent(g, record, component, root));
                        // The accessor is generated by the compiler but real to every caller, so it is a member with a
                        // position: the component's own line. Spoon may already expose it; then there is nothing to add.
                        // Spoon lists the accessor but without a source position; the component is the position a
                        // citation can use, so the generated row is written unless a real body was authored.
                        boolean authored = record.getMethods().stream()
                                .anyMatch(m -> m.getSimpleName().equals(component.getSimpleName())
                                        && m.getParameters().isEmpty()
                                        && m.getPosition() != null && m.getPosition().isValidPosition());
                        if (!authored) w.row(g -> recordAccessor(g, record, component, root));
                    }
                }
            }
        }
    }

    private static void field(JsonGenerator g, CtType<?> owner, CtField<?> f, Path root) throws IOException {
        g.writeStringField("kind", "field");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", f.getSimpleName());
        g.writeStringField("type", Names.typeText(f.getType()));
        // The type as the compiler names it: a declaration's field type is a fact, not something Node resolves.
        g.writeStringField("typeFqn", f.getType() == null ? null : f.getType().getQualifiedName());
        modifiers(g, f.getModifiers());
        Anns.write(g, f.getAnnotations());
        Ndjson.pos(g, Positions.of(f, root));
        writeConstant(g, f);
    }

    private static void enumConstant(JsonGenerator g, CtType<?> owner, CtEnumValue<?> v, Path root) throws IOException {
        g.writeStringField("kind", "enumConstant");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", v.getSimpleName());
        Anns.write(g, v.getAnnotations());
        Ndjson.pos(g, Positions.of(v, root));
        g.writeArrayFieldStart("args");
        List<CtExpression<?>> args = new ArrayList<>();
        CtExpression<?> init = v.getDefaultExpression();
        if (init instanceof CtNewArray<?> array) args.addAll(array.getElements());
        else if (init instanceof spoon.reflect.code.CtConstructorCall<?> call) args.addAll(call.getArguments());
        for (CtExpression<?> element : args) {
            Values.Value value = Values.of(element);
            Anns.writeValue(g, value == null ? new Values.Value("unresolved", null) : value);
        }
        g.writeEndArray();
    }

    /** The loops a body writes, as line ranges: a worker is a poll inside one, and Node must not re-read the body. */
    private static void loops(JsonGenerator g, CtExecutable<?> e, Path root) throws IOException {
        g.writeArrayFieldStart("loops");
        for (spoon.reflect.code.CtLoop loop : e.getElements(
                new spoon.reflect.visitor.filter.TypeFilter<>(spoon.reflect.code.CtLoop.class))) {
            Positions.Pos p = Positions.of(loop, root);
            if (p == null) continue;
            g.writeStartObject();
            g.writeNumberField("start", p.line());
            g.writeNumberField("end", p.endLine());
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    /**
     * The decision arms a body writes, as line ranges: an if/else arm's body, a catch's body, a case's statements.
     * Never the condition — a call written in {@code if (repo.exists())} runs on the default path — so Node can say an
     * effect reached only through an arm is conditional without re-reading the body.
     */
    private static void branches(JsonGenerator g, CtExecutable<?> e, Path root) throws IOException {
        List<Arm> arms = new ArrayList<>();
        for (CtIf iff : e.getElements(new spoon.reflect.visitor.filter.TypeFilter<>(CtIf.class))) {
            arm(arms, iff.getThenStatement(), "if", root);
            CtStatement otherwise = iff.getElseStatement();
            // An else-if's arms are that nested if's own rows; the else itself has no body to range.
            if (otherwise != null && !(otherwise instanceof CtIf)) arm(arms, otherwise, "else", root);
        }
        for (CtCatch c : e.getElements(new spoon.reflect.visitor.filter.TypeFilter<>(CtCatch.class)))
            arm(arms, c.getBody(), "catch", root);
        // A case's statements, not the case: the label and its guard are the decision, not the arm.
        for (CtCase<?> c : e.getElements(new spoon.reflect.visitor.filter.TypeFilter<>(CtCase.class)))
            for (CtStatement s : c.getStatements()) arm(arms, s, "case", root);
        // Source order, so the dump is byte-identical across runs and a reader can scan it.
        arms.sort(java.util.Comparator.comparingInt(Arm::start).thenComparingInt(Arm::end).thenComparing(Arm::kind));
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

    private static void arm(List<Arm> arms, CtElement statement, String kind, Path root) {
        Positions.Pos p = Positions.of(statement, root);
        if (p == null) return;
        arms.add(new Arm(p.line(), p.endLine(), kind));
    }

    private static void callable(JsonGenerator g, CtType<?> owner, CtExecutable<?> executable,
            boolean constructor, Path root) throws IOException {
        // A constructor is named after its type, as the Node model always spelled it: Cargo#Cargo(TrackingId).
        String name = constructor ? owner.getSimpleName() : executable.getSimpleName();
        g.writeStringField("kind", constructor ? "constructor" : "method");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", name);
        List<CtTypeReference<?>> paramTypes = new ArrayList<>();
        g.writeArrayFieldStart("params");
        for (CtParameter<?> p : executable.getParameters()) {
            paramTypes.add(p.getType());
            g.writeStartObject();
            g.writeStringField("type", Names.typeText(p.getType()));
            g.writeStringField("name", p.getSimpleName());
            g.writeBooleanField("varargs", p.isVarArgs());
            // Parameter annotations carry meaning too (@PathVariable, @RequestBody, a tenant id).
            Anns.write(g, p.getAnnotations());
            g.writeEndObject();
        }
        g.writeEndArray();
        g.writeStringField("id", Names.methodId(owner, name, paramTypes));
        if (executable instanceof CtMethod<?> method) g.writeStringField("returns", Names.typeText(method.getType()));
        modifiers(g, ((spoon.reflect.declaration.CtModifiable) executable).getModifiers());
        g.writeBooleanField("hasBody", executable.getBody() != null);
        g.writeArrayFieldStart("throws");
        for (CtTypeReference<?> thrown : executable.getThrownTypes()) g.writeString(Names.typeText(thrown));
        g.writeEndArray();
        Anns.write(g, executable.getAnnotations());
        loops(g, executable, root);
        branches(g, executable, root);
        Ndjson.pos(g, Positions.of(executable, root));
    }

    /** A method of an anonymous or local class, filed under the type whose body writes it (id carries the line). */
    private static void anonymous(JsonGenerator g, CtType<?> owner, CtMethod<?> m, Path root) throws IOException {
        g.writeStringField("kind", "method");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", m.getSimpleName());
        g.writeArrayFieldStart("params");
        for (CtParameter<?> p : m.getParameters()) {
            g.writeStartObject();
            g.writeStringField("type", Names.typeText(p.getType()));
            g.writeStringField("name", p.getSimpleName());
            g.writeBooleanField("varargs", p.isVarArgs());
            Anns.write(g, p.getAnnotations());
            g.writeEndObject();
        }
        g.writeEndArray();
        g.writeStringField("id", Anonymous.id(owner, m, root));
        g.writeStringField("returns", Names.typeText(m.getType()));
        modifiers(g, m.getModifiers());
        g.writeBooleanField("hasBody", m.getBody() != null);
        g.writeBooleanField("anonymous", true);
        g.writeArrayFieldStart("throws");
        for (CtTypeReference<?> thrown : m.getThrownTypes()) g.writeString(Names.typeText(thrown));
        g.writeEndArray();
        Anns.write(g, m.getAnnotations());
        loops(g, m, root);
        branches(g, m, root);
        Ndjson.pos(g, Positions.of(m, root));
    }

    private static void recordComponent(JsonGenerator g, CtRecord owner, CtRecordComponent c, Path root)
            throws IOException {
        g.writeStringField("kind", "recordComponent");
        g.writeStringField("owner", Names.qualified(owner));
        g.writeStringField("name", c.getSimpleName());
        g.writeStringField("type", Names.typeText(c.getType()));
        Anns.write(g, c.getAnnotations());
        Ndjson.pos(g, Positions.of(c, root));
    }

    private static void recordAccessor(JsonGenerator g, CtRecord owner, CtRecordComponent c, Path root)
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
        Ndjson.pos(g, Positions.of(c, root));
    }

    private static List<CtTypeReference<?>> paramTypes(CtExecutable<?> executable) {
        List<CtTypeReference<?>> out = new ArrayList<>();
        for (CtParameter<?> p : executable.getParameters()) out.add(p.getType());
        return out;
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
        modifiers(g, item.modifiers());
        g.writeBooleanField("hasBody", false);
        g.writeStringField("generated", "lombok");
        g.writeStringField("generatedBy", item.from());
        g.writeArrayFieldStart("throws");
        g.writeEndArray();
        g.writeArrayFieldStart("ann");
        g.writeEndArray();
        Ndjson.pos(g, item.pos());
    }

    private static void modifiers(JsonGenerator g, Set<ModifierKind> modifiers) throws IOException {
        // Sorted: an immutable set's iteration order is salted per JVM, and the dump must be byte-identical across runs.
        List<String> names = new ArrayList<>();
        for (ModifierKind m : modifiers) names.add(m.toString());
        java.util.Collections.sort(names);
        g.writeArrayFieldStart("modifiers");
        for (String m : names) g.writeString(m);
        g.writeEndArray();
    }

    private static void writeConstant(JsonGenerator g, CtField<?> field) throws IOException {
        if (!field.getModifiers().contains(ModifierKind.FINAL) || field.getDefaultExpression() == null) return;
        Values.Value value = Values.of(field.getDefaultExpression());
        if (value == null) return;
        g.writeFieldName("value");
        Anns.writeValue(g, value);
    }
}
