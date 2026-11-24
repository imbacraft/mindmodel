package shop;

import jakarta.persistence.Entity;

@Entity
public class Item {
    private StageStatus state = StageStatus.DRAFT;

    public StageStatus getState() {
        return state;
    }

    public void setState(StageStatus state) {
        this.state = state;
    }
}
