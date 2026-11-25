package mindmodel.engine.resolve;

import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtType;

/** The kind of a declared type, as the rows spell it. */
public final class Types {

    private Types() {
    }

    public static String kind(CtType<?> t) {
        if (t.isAnnotationType()) return "annotation";
        if (t.isInterface()) return "interface";
        if (t.isEnum()) return "enum";
        if (t instanceof CtRecord) return "record";
        return "class";
    }
}
