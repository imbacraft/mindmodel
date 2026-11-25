package mindmodel.engine.dump;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtRecordComponent;
import spoon.reflect.declaration.CtTypeMember;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.reference.CtWildcardReference;

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
        List<String> wanted = typeKeys(componentTypes(record));
        for (CtTypeMember member : record.getTypeMembers()) {
            if (!(member instanceof CtConstructor<?> ctor)) continue;
            if (ctor.isCompactConstructor()) return ctor;
            List<CtTypeReference<?>> params = new ArrayList<>();
            for (var p : ctor.getParameters()) params.add(p.getType());
            if (typeKeys(params).equals(wanted)) return ctor;
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
    static Positions.Pos citation(CtRecord record, CtConstructor<?> ctor, Positions positions) {
        Positions.Pos own = ctor == null ? null : positions.of(ctor);
        return own != null ? own : positions.of(record);
    }

    /** The canonical constructor's access: its own modifiers, or the record's visibility when Spoon modelled none. */
    static Set<ModifierKind> modifiers(CtRecord record, CtConstructor<?> ctor) {
        if (ctor != null) return ctor.getModifiers();
        Set<ModifierKind> out = new LinkedHashSet<>();
        for (ModifierKind kind : record.getModifiers())
            if (kind == ModifierKind.PUBLIC || kind == ModifierKind.PROTECTED || kind == ModifierKind.PRIVATE)
                out.add(kind);
        return out;
    }

    /**
     * The resolved keys of a parameter list, sorted. The author may write `String` for a component the record header
     * wrote `java.lang.String`: both name one type, so the comparison is on resolved names, never on the spelling.
     */
    private static List<String> typeKeys(List<CtTypeReference<?>> types) {
        List<String> out = new ArrayList<>();
        for (CtTypeReference<?> type : types) out.add(resolvedKey(type));
        Collections.sort(out);
        return out;
    }

    /** A type's qualified name with its type arguments, each resolved the same way. */
    static String resolvedKey(CtTypeReference<?> type) {
        if (type == null) return "?";
        if (type instanceof CtWildcardReference wildcard) {
            CtTypeReference<?> bound = Names.wildcardBound(wildcard);
            return bound == null ? "?" : (wildcard.isUpper() ? "? extends " : "? super ") + resolvedKey(bound);
        }
        StringBuilder out = new StringBuilder(Names.qualified(type));
        List<CtTypeReference<?>> args = type.getActualTypeArguments();
        if (!args.isEmpty()) {
            out.append('<');
            for (CtTypeReference<?> arg : args) out.append(resolvedKey(arg)).append(',');
            out.append('>');
        }
        return out.toString();
    }
}
