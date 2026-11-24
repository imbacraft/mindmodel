package contract;

/** A local compared with a constant: one built from a call (the dump names its source), one from a literal. */
public class Compare {
    static final String NAME = "n";

    boolean fromCall(Object raw) {
        String given = String.valueOf(raw);
        return NAME.equals(given);
    }

    boolean fromLiteral() {
        String given = "session";
        return NAME.equals(given);
    }
}
