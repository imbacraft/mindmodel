package mindmodel.engine.model;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The problems each input file carries: its syntax errors as the parser reported them, and the bare-shell types the
 * second read could not fill. Silence is the one thing the dump may not do, so each problem is named.
 */
public final class FileProblems {

    /**
     * One problem: its kind (`syntax`, `not-read`, `type-without-position`), the reason, and the line (null when
     * one).
     */
    public record Problem(String kind, String reason, Integer line) {
    }

    private FileProblems() {
    }

    /** Syntax errors by project-relative file, plus each file Spoon left a bare shell for. */
    public static Map<String, List<Problem>> of(SourceModel model, Positions positions, List<String> unread) {
        Map<String, List<Problem>> out = new LinkedHashMap<>();
        Path base = positions.root();
        for (var problem : model.problems()) {
            char[] name = problem.getOriginatingFileName();
            if (name == null) continue;
            // Without a classpath JDT reports every missing framework type, every Lombok accessor and every feature
            // above the compliance level. None of that means the file is unreadable: only a syntax error does.
            String message = problem.getMessage();
            if (!message.startsWith("Syntax error")) continue;
            Path file = Path.of(new String(name)).toAbsolutePath().normalize();
            if (!file.startsWith(base) || model.isGeneratedFile(file)) continue;
            String rel = base.relativize(file).toString().replace('\\', '/');
            int line = problem.getSourceLineNumber();
            out.computeIfAbsent(rel, k -> new ArrayList<>())
                    .add(new Problem("syntax", Failures.scrub(message), line > 0 ? line : null));
        }
        for (String rel : unread)
            out.computeIfAbsent(rel, k -> new ArrayList<>())
                    .add(new Problem("type-without-position", "type-without-position", null));
        return out;
    }
}
