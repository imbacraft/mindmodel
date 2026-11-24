package generic;

public class OnlyImpl implements OnlyPort {
    @Override
    public void go(Row row) {
        row.revise();
    }
}
