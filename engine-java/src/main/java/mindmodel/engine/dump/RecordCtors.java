package mindmodel.engine.dump;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtRecordComponent;
import spoon.reflect.declaration.CtTypeMember;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtTypeReference;

/**
 * A record's canonical constructor, read from its components.
 *
 * Spoon 11.5 hands the canonical constructor back with its parameters in {@code [c0] + reverse(rest)} order (and leaves
 * it out entirely for a nested record), so the parameter list of the member Spoon returns is not the declaration the
 * author wrote. The record components always are, in source order: the dump writes the constructor from them, and cites
 * the compact constructor or the record header — the line the implicit constructor belongs to.
 */
final class RecordCtors {

    private RecordCtors() {
    }

    /** The components in declaration order: the canonical constructor's parameters, as the author wrote them. */
    static List<CtRecordComponent> components(CtRecord record) {
        return new ArrayList<>(record.getRecordComponents());
    }

    static List<CtTypeReference<?>> componentTypes(CtRecord record) {
        List<CtTypeReference<?>> out = new ArrayList<>();
        for (CtRecordComponent component : components(record)) out.add(component.getType());
        return out;
    }

    /** The id every call to this record's canonical constructor resolves to, in component order. */
    static String id(CtRecord record) {
        return Names.methodId(record, record.getSimpleName(), componentTypes(record));
    }

    /**
     * The constructor Spoon modelled for the components, or null when it modelled none (the nested-record case). A
     * compact constructor, or one whose parameter types are exactly the components' types, is the canonical one.
     */
    static CtConstructor<?> canonical(CtRecord record) {
        List<String> wanted = typeTexts(componentTypes(record));
        for (CtTypeMember member : record.getTypeMembers()) {
            if (!(member instanceof CtConstructor<?> ctor)) continue;
            if (ctor.isCompactConstructor()) return ctor;
            List<CtTypeReference<?>> params = new ArrayList<>();
            for (var p : ctor.getParameters()) params.add(p.getType());
            if (typeTexts(params).equals(wanted)) return ctor;
        }
        return null;
    }

    /** True when this constructor is the canonical one, so its parameter list must be written from the components. */
    static boolean isCanonical(CtRecord record, CtConstructor<?> ctor) {
        if (ctor.isCompactConstructor()) return true;
        CtConstructor<?> found = canonical(record);
        return found != null && found == ctor;
    }

    /** The line the implicit constructor belongs to: the compact constructor if written, else the record header. */
    static Positions.Pos citation(CtRecord record, CtConstructor<?> ctor, Path root) {
        Positions.Pos own = ctor == null ? null : Positions.of(ctor, root);
        return own != null ? own : Positions.of(record, root);
    }

    /** The canonical constructor's access: its own modifiers, or the record's visibility when Spoon modelled none. */
    static java.util.Set<ModifierKind> modifiers(CtRecord record, CtConstructor<?> ctor) {
        if (ctor != null) return ctor.getModifiers();
        java.util.Set<ModifierKind> out = new java.util.LinkedHashSet<>();
        for (ModifierKind kind : record.getModifiers())
            if (kind == ModifierKind.PUBLIC || kind == ModifierKind.PROTECTED || kind == ModifierKind.PRIVATE)
                out.add(kind);
        return out;
    }

    /** Type texts, sorted: two parameter lists describe the same signature whatever order Spoon wrote them in. */
    private static List<String> typeTexts(List<CtTypeReference<?>> types) {
        List<String> out = new ArrayList<>();
        for (CtTypeReference<?> type : types) out.add(Names.typeText(type));
        java.util.Collections.sort(out);
        return out;
    }
}
