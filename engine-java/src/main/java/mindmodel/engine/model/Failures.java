package mindmodel.engine.model;

import java.util.Map;
import java.util.TreeMap;

/**
 * Counts the places the dump answers empty instead of failing, by key. One instance per run; meta.json writes the
 * counts, so a run says what it could not read rather than hiding it.
 */
public final class Failures {

    /** Every key a run can count, with the dotted name meta.json writes it under. */
    public enum Key {
        /** Two input files declare the same name; the first in sorted order keeps it. */
        DUPLICATE_FQN("types.duplicateFqn"),
        /** A type reference the dump could not name (see resolve.Refs). */
        TYPE_UNRESOLVED("refs.typeUnresolved"),
        /** A type's arguments could not be read, so it lists none. */
        TYPE_ARGS_UNRESOLVED("refs.typeArgsUnresolved"),
        /** An expression's source text could not be read, so its text is null. */
        TEXT_UNRESOLVED("refs.textUnresolved"),
        /** A receiver's classpath type could not be read, so its chain has no type. */
        CHAIN_TYPE_UNRESOLVED("chains.typeUnresolved"),
        /** A supertype's type arguments could not be bound, so its parameters stay open. */
        BINDINGS_UNRESOLVED("sites.bindingsUnresolved"),
        /** An error row's call name could not be read, so the row's name is null. */
        NAME_UNRESOLVED("sites.nameUnresolved"),
        /** A body's returns could not be read, so its member's returned list is empty. */
        RETURNS_UNREADABLE("returns.unreadable"),
        /** A field access's static flag could not be decided, so it is null (unknown), not false. */
        MODIFIERS_UNREADABLE("fields.modifiersUnreadable"),
        /** A file's imports could not be read, so its import origin is unresolved. */
        IMPORTS_UNREADABLE("files.importsUnreadable");

        private final String dotted;

        Key(String dotted) {
            this.dotted = dotted;
        }

        /** The name meta.json counts it under. */
        public String dotted() {
            return dotted;
        }
    }

    private final Map<String, Integer> counts = new TreeMap<>();

    /** One more failure under {@code key}. */
    public void count(Key key) {
        counts.merge(key.dotted(), 1, Integer::sum);
    }

    /** The counts so far, sorted by key. */
    public Map<String, Integer> counts() {
        return counts;
    }

    /** The reason an error row carries: {@code ExceptionClass: message}. */
    public static String reason(Throwable failure) {
        return failure.getClass().getSimpleName() + ": " + failure.getMessage();
    }

    /**
     * The reason a library row carries: the class, then the message when there is a non-blank one, at most 200
     * characters.
     */
    public static String brief(Throwable failure) {
        String why = failure.getClass().getSimpleName();
        if (failure.getMessage() != null && !failure.getMessage().isBlank()) why += ": " + failure.getMessage();
        return why.length() > 200 ? why.substring(0, 200) : why;
    }
}
