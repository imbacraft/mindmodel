package mindmodel.engine.model;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * Counts the places the dump answers empty instead of failing, by key. One instance per run; meta.json writes the
 * counts, so a run says what it could not read rather than hiding it.
 */
public final class Failures {

    /** Every key a run can count, with the dotted name meta.json writes it under. */
    public enum Key {
        /** Two input files declare the same name; the file whose relative path sorts first keeps it. */
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
        IMPORTS_UNREADABLE("files.importsUnreadable"),
        /** A source that is not valid UTF-8, read as ISO-8859-1: its non-ASCII text may not be the author's. */
        NOT_UTF8("files.notUtf8"),
        /** A classpath entry that is missing or not readable, dropped before the model was built (meta lists it). */
        CLASSPATH_UNREADABLE("classpath.unreadable"),
        /** An input file that cannot be opened: it is not dumped, and Spoon never sees it. */
        FILE_UNREADABLE("files.unreadable");

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

    /** The folders a run's messages may name, as patterns: longest first, set once per run by {@link #knownPaths}. */
    private static volatile List<Pattern> knownPatterns = List.of();

    /** Ends a path: whitespace, a colon, a quote, a bracket, a comma or a semicolon. */
    private static final String PATH_END = "\\s:'\"`,;()\\[\\]";

    /**
     * An absolute path in a message that no known folder covers: a POSIX path, or a Windows one with a drive letter.
     * shortcut: such a path with a space in it keeps its tail after the space, upgrade when a message shows one.
     */
    private static final Pattern ABSOLUTE_PATH =
            Pattern.compile("(?<![\\w.])(?:[A-Za-z]:\\\\\\S+|(?:/[\\w.@+~-]+)+)");

    /**
     * Names the folders a run's messages may hold: the given and the canonical checkout, the folder of each classpath
     * entry, and the home directory. {@link #scrub} replaces each whole, as an exact prefix, so a folder with a space
     * in its name goes too.
     */
    public static void knownPaths(List<Path> roots, List<String> classpath) {
        List<String> folders = new ArrayList<>();
        for (Path root : roots) {
            folders.add(root.toAbsolutePath().normalize().toString());
            folders.add(SourceModel.realPath(root).toString());
        }
        for (String entry : classpath) {
            Path parent = Path.of(entry).toAbsolutePath().normalize().getParent();
            if (parent != null) folders.add(parent.toString());
        }
        folders.add(System.getProperty("user.home"));
        folders.removeIf(f -> f == null || f.isBlank() || f.equals("/"));
        folders.sort(Comparator.comparingInt(String::length).reversed().thenComparing(Comparator.naturalOrder()));
        List<Pattern> patterns = new ArrayList<>();
        for (String folder : folders)
            patterns.add(Pattern.compile(Pattern.quote(folder) + "(?=[/" + PATH_END + "]|$)[^" + PATH_END + "]*"));
        knownPatterns = List.copyOf(patterns);
    }

    /**
     * The text with its absolute paths replaced by {@code <path>}. Every message the dump writes goes through here, so
     * an output never says where the checkout or a jar lives: that is the host, and the dump must not carry it. A known
     * folder is matched as an exact prefix, so a space in its name is no end; a path no known folder covers falls back
     * to the pattern.
     */
    public static String scrub(String text) {
        if (text == null) return null;
        String out = text;
        for (Pattern known : knownPatterns) out = known.matcher(out).replaceAll("<path>");
        return ABSOLUTE_PATH.matcher(out).replaceAll("<path>");
    }

    /** The reason an error row carries: {@code ExceptionClass: message}, with no absolute path in it. */
    public static String reason(Throwable failure) {
        return scrub(failure.getClass().getSimpleName() + ": " + failure.getMessage());
    }

    /**
     * The reason a library row carries: the class, then the message when there is a non-blank one, at most 200
     * characters.
     */
    public static String brief(Throwable failure) {
        String why = failure.getClass().getSimpleName();
        if (failure.getMessage() != null && !failure.getMessage().isBlank()) why += ": " + failure.getMessage();
        why = scrub(why);
        return why.length() > 200 ? why.substring(0, 200) : why;
    }
}
