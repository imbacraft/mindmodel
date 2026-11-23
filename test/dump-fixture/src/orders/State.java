package orders;

public enum State {
    NEW("new"),
    DONE("done") {
        @Override
        public boolean terminal() { return true; }
    };

    private final String code;

    State(String code) { this.code = code; }

    public String code() { return code; }

    public boolean terminal() { return false; }
}
