package contract;

import orders.State;

public class Returns {
    String literal() { return "name"; }

    String constant() { return Labels.NEW; }

    String param(String input) { return input; }

    State fromSwitch(State state) {
        return switch (state) {
            case NEW -> State.DONE;
            default -> State.NEW;
        };
    }

    String chosen(State state) {
        String code;
        switch (state) {
            case NEW: code = "new"; break;
            default: code = "done"; break;
        }
        return code;
    }

    String assigned(State state) {
        String code = switch (state) {
            case NEW -> "new";
            default -> "done";
        };
        return code;
    }

    String conditional(State state) { return state == State.NEW ? Labels.NEW : "done"; }

    String unknown() { return mystery.value; }
}
